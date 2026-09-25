#include "friday_client.h"

#include "esphome/core/hal.h"
#include "esphome/core/log.h"
#include "esphome/components/json/json_util.h"

#include <esp_heap_caps.h>
#include <cstring>

namespace esphome::friday_client {

static const char *const TAG = "friday_client";

// Two seconds of 16 kHz s16le mono. Oldest audio is dropped when it fills.
static constexpr size_t MIC_RB_BYTES = 64000;
// Four seconds of 24 kHz s16le mono from the server, queued for the player task.
static constexpr size_t PLAY_RB_BYTES = 192000;
static constexpr TickType_t PLAY_WAIT = pdMS_TO_TICKS(100);
struct PlayItem {
  uint32_t gen;
  uint8_t data[];
};
static constexpr uint8_t WS_OP_TEXT = 0x1, WS_OP_BINARY = 0x2, WS_OP_CLOSE = 0x8;

const char *state_name(State s) {
  switch (s) {
    case State::IDLE: return "idle";
    case State::CONNECTING: return "connecting";
    case State::LISTENING: return "listening";
    case State::SPEAKING: return "speaking";
    case State::ERROR: return "error";
  }
  return "?";
}

// ------------------------------------------------------------------ lifecycle

void FridayClient::setup() {
  this->client_mutex_ = xSemaphoreCreateMutex();
  this->mic_rb_ = xRingbufferCreateWithCaps(MIC_RB_BYTES, RINGBUF_TYPE_BYTEBUF, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (this->mic_rb_ == nullptr) this->mic_rb_ = xRingbufferCreate(MIC_RB_BYTES, RINGBUF_TYPE_BYTEBUF);
  if (this->mic_rb_ == nullptr) {
    ESP_LOGE(TAG, "could not allocate microphone buffer");
    this->mark_failed();
    return;
  }
  this->play_rb_ = xRingbufferCreateWithCaps(PLAY_RB_BYTES, RINGBUF_TYPE_NOSPLIT, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (this->play_rb_ == nullptr) this->play_rb_ = xRingbufferCreate(PLAY_RB_BYTES, RINGBUF_TYPE_NOSPLIT);
  if (this->play_rb_ == nullptr) {
    ESP_LOGE(TAG, "could not allocate playback buffer");
    this->mark_failed();
    return;
  }
  this->mic_source_->add_data_callback([this](const std::vector<uint8_t> &d) { this->on_mic_data_(d); });
  xTaskCreate(FridayClient::sender_task_trampoline_, "friday_send", 4096, this, 5, &this->sender_task_handle_);
  xTaskCreate(FridayClient::player_task_trampoline_, "friday_play", 4096, this, 6, &this->player_task_handle_);
}

void FridayClient::dump_config() {
  ESP_LOGCONFIG(TAG, "Friday client:\n  URL: %s\n  Device id: %s\n  Send chunk: %u bytes", this->url_.c_str(),
                this->device_id_.c_str(), (unsigned) this->send_chunk_bytes_);
}

void FridayClient::loop() {
  const uint32_t now = millis();

  if (this->state_dirty_.exchange(false)) {
    this->state_cb_.call(state_name(this->get_state()));
  }

  // Destroying the client must not happen from its own event task.
  if (this->teardown_requested_.exchange(false)) {
    xSemaphoreTake(this->client_mutex_, portMAX_DELAY);
    if (this->client_ != nullptr) {
      esp_websocket_client_close(this->client_, pdMS_TO_TICKS(500));
      esp_websocket_client_destroy(this->client_);
      this->client_ = nullptr;
    }
    this->connected_ = false;
    xSemaphoreGive(this->client_mutex_);
  }

  switch (this->get_state()) {
    case State::CONNECTING:
      if (now - this->connect_started_at_ > this->connect_timeout_ms_) this->fail_("connect timeout");
      break;
    case State::SPEAKING:
      if (this->turn_done_ && !this->playback_pending_()) {
        this->turn_done_ = false;
        this->set_state_(State::LISTENING);
      }
      break;
    case State::ERROR:
      if (now - this->error_since_ > this->error_hold_ms_) this->go_idle_();
      break;
    default:
      break;
  }

  if (this->draining_) {
    bool done = !this->playback_pending_() || (now - this->drain_started_at_ > this->drain_timeout_ms_);
    if (done) {
      this->draining_ = false;
      this->speaker_flush_();
      this->request_teardown_();
      this->go_idle_();
    }
  }
}

// ------------------------------------------------------------------ actions

void FridayClient::start() {
  if (this->get_state() != State::IDLE) return;
  if (this->mic_ != nullptr && this->mic_->get_mute_state()) {
    ESP_LOGW(TAG, "microphone is muted, not starting");
    this->error();
    return;
  }
  this->user_stopping_ = false;
  this->draining_ = false;
  this->turn_done_ = false;
  this->text_acc_.clear();
  this->connect_started_at_ = millis();
  this->set_state_(State::CONNECTING);
  if (!this->connect_()) this->fail_("could not create websocket client");
}

void FridayClient::stop() {
  if (this->get_state() == State::IDLE) return;
  this->user_stopping_ = true;
  this->draining_ = false;
  this->mic_stop_();
  this->speaker_flush_();
  this->request_teardown_();
  this->go_idle_();
}

void FridayClient::toggle() {
  if (this->get_state() == State::IDLE) this->start();
  else this->stop();
}

void FridayClient::error() {
  if (this->is_active()) this->stop();
  this->fail_("requested");
}

// ------------------------------------------------------------------ state

void FridayClient::set_state_(State s) {
  if (this->state_.exchange(s) == s) return;
  ESP_LOGD(TAG, "-> %s", state_name(s));
  this->state_dirty_ = true;
}

void FridayClient::fail_(const char *why) {
  ESP_LOGW(TAG, "error: %s", why);
  this->mic_stop_();
  this->speaker_flush_();
  this->draining_ = false;
  this->request_teardown_();
  this->error_since_ = millis();
  this->set_state_(State::ERROR);
}

void FridayClient::go_idle_() {
  this->mic_stop_();
  this->set_state_(State::IDLE);
}

// ------------------------------------------------------------------ websocket

bool FridayClient::connect_() {
  std::string uri = this->url_;
  if (!this->device_id_.empty()) {
    uri += (uri.find('?') == std::string::npos) ? "?device=" : "&device=";
    uri += this->device_id_;
  }
  esp_websocket_client_config_t cfg = {};
  cfg.uri = uri.c_str();
  cfg.buffer_size = 4096;
  cfg.task_stack = 8192;
  cfg.disable_auto_reconnect = true;
  cfg.network_timeout_ms = this->connect_timeout_ms_;
  cfg.reconnect_timeout_ms = this->connect_timeout_ms_;
  cfg.ping_interval_sec = 10;

  xSemaphoreTake(this->client_mutex_, portMAX_DELAY);
  if (this->client_ != nullptr) {
    esp_websocket_client_destroy(this->client_);
    this->client_ = nullptr;
  }
  this->client_ = esp_websocket_client_init(&cfg);
  bool ok = this->client_ != nullptr;
  if (ok) {
    esp_websocket_register_events(this->client_, WEBSOCKET_EVENT_ANY, FridayClient::ws_event_trampoline_, this);
    ok = esp_websocket_client_start(this->client_) == ESP_OK;
  }
  xSemaphoreGive(this->client_mutex_);
  ESP_LOGI(TAG, "connecting to %s", uri.c_str());
  return ok;
}

void FridayClient::request_teardown_() {
  this->connected_ = false;
  this->teardown_requested_ = true;
}

void FridayClient::ws_event_trampoline_(void *arg, esp_event_base_t, int32_t event_id, void *event_data) {
  static_cast<FridayClient *>(arg)->on_ws_event_(event_id, static_cast<esp_websocket_event_data_t *>(event_data));
}

void FridayClient::on_ws_event_(int32_t event_id, esp_websocket_event_data_t *d) {
  switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
      ESP_LOGI(TAG, "connected");
      this->connected_ = true;
      this->speaker_started_ = false;
      this->speaker_begin_();  // warm the pipeline so the first burst of audio is not dropped
      this->mic_start_();
      this->set_state_(State::LISTENING);
      break;

    case WEBSOCKET_EVENT_DATA: {
      uint8_t op = d->op_code;
      if (op == 0x0) op = this->last_opcode_;  // continuation frame
      else this->last_opcode_ = op;
      if (op == WS_OP_BINARY) {
        if (d->data_len > 0) this->on_audio_frame_(reinterpret_cast<const uint8_t *>(d->data_ptr), d->data_len);
      } else if (op == WS_OP_TEXT) {
        if (d->payload_offset == 0) this->text_acc_.clear();
        this->text_acc_.append(d->data_ptr, d->data_len);
        if (d->payload_offset + d->data_len >= d->payload_len) {
          this->on_text_frame_(this->text_acc_);
          this->text_acc_.clear();
        }
      } else if (op == WS_OP_CLOSE) {
        ESP_LOGD(TAG, "server sent close frame");
      }
      break;
    }

    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_ERROR:
    case WEBSOCKET_EVENT_CLOSED:
      if (this->connected_.exchange(false) || this->get_state() == State::CONNECTING) {
        // Expected when we asked for it or Friday said goodbye; otherwise an error.
        if (!this->user_stopping_ && !this->draining_) {
          this->fail_(event_id == WEBSOCKET_EVENT_ERROR ? "connection error" : "connection lost");
        }
      }
      break;

    default:
      break;
  }
}

void FridayClient::on_text_frame_(const std::string &raw) {
  bool ok = json::parse_json(raw, [this](JsonObject root) -> bool {
    const char *type = root["type"];
    if (type == nullptr) return false;
    if (strcmp(type, "interrupted") == 0) {
      ESP_LOGD(TAG, "interrupted");
      this->speaker_flush_();
      this->turn_done_ = false;
      if (this->get_state() == State::SPEAKING) this->set_state_(State::LISTENING);
    } else if (strcmp(type, "turn_complete") == 0) {
      this->turn_done_ = true;
    } else if (strcmp(type, "closed") == 0) {
      const char *reason = root["data"];
      ESP_LOGI(TAG, "session closed by server: %s", reason ? reason : "");
      this->mic_stop_();
      this->drain_started_at_ = millis();
      this->draining_ = true;
      if (this->speaker_started_) this->speaker_->finish();
    } else {
      ESP_LOGV(TAG, "ignoring event %s", type);
    }
    return true;
  });
  if (!ok) ESP_LOGW(TAG, "unparseable text frame (%u bytes)", (unsigned) raw.size());
}

// ------------------------------------------------------------------ speaker

void FridayClient::speaker_begin_() {
  if (this->speaker_started_.exchange(true)) return;
  this->speaker_->set_audio_stream_info(audio::AudioStreamInfo(16, 1, 24000));
  this->speaker_->start();
}

/// Drop everything queued and playing. Safe from any task: the player task
/// discards items whose generation is stale.
void FridayClient::speaker_flush_() {
  this->play_gen_++;
  this->play_pending_ = 0;
  if (this->speaker_started_.exchange(false)) this->speaker_->stop();
}

void FridayClient::on_audio_frame_(const uint8_t *data, size_t len) {
  if (this->draining_ || this->user_stopping_) return;
  if (this->get_state() == State::LISTENING) {
    this->turn_done_ = false;
    this->set_state_(State::SPEAKING);
  }
  // Never block here: this runs in the websocket task and would stall the mic sender.
  void *slot = nullptr;
  if (xRingbufferSendAcquire(this->play_rb_, &slot, sizeof(PlayItem) + len, 0) != pdTRUE) {
    uint32_t now = millis();
    if (now - this->drop_warn_at_ > 1000) {
      this->drop_warn_at_ = now;
      ESP_LOGW(TAG, "playback queue full, dropped %u bytes", (unsigned) len);
    }
    return;
  }
  auto *item = static_cast<PlayItem *>(slot);
  item->gen = this->play_gen_.load();
  memcpy(item->data, data, len);
  this->play_pending_ += len;
  xRingbufferSendComplete(this->play_rb_, slot);
}

void FridayClient::player_task_trampoline_(void *arg) { static_cast<FridayClient *>(arg)->player_task_(); }

void FridayClient::player_task_() {
  for (;;) {
    size_t size = 0;
    auto *item = static_cast<PlayItem *>(xRingbufferReceive(this->play_rb_, &size, pdMS_TO_TICKS(100)));
    if (item == nullptr) continue;
    const size_t len = size - sizeof(PlayItem);
    if (item->gen == this->play_gen_.load()) {
      this->speaker_begin_();
      size_t off = 0;
      uint32_t stalled_since = 0;
      while (off < len && item->gen == this->play_gen_.load() && !this->user_stopping_) {
        size_t w = this->speaker_->play(item->data + off, len - off, PLAY_WAIT);
        off += w;
        if (w > 0) {
          stalled_since = 0;
        } else {
          uint32_t now = millis();
          if (stalled_since == 0) stalled_since = now;
          else if (now - stalled_since > 3000) {
            ESP_LOGW(TAG, "speaker not accepting audio, dropped %u bytes", (unsigned) (len - off));
            break;
          }
        }
      }
    }
    // Only subtract what this item contributed; a flush already zeroed the counter.
    size_t cur = this->play_pending_.load();
    while (cur > 0 && !this->play_pending_.compare_exchange_weak(cur, cur > len ? cur - len : 0)) {}
    vRingbufferReturnItem(this->play_rb_, item);
  }
}

// ------------------------------------------------------------------ microphone

void FridayClient::mic_start_() {
  // Discard anything captured before this session.
  size_t n;
  void *p;
  while ((p = xRingbufferReceiveUpTo(this->mic_rb_, &n, 0, MIC_RB_BYTES)) != nullptr) {
    vRingbufferReturnItem(this->mic_rb_, p);
  }
  this->mic_enabled_ = true;
  this->mic_source_->start();
}

void FridayClient::mic_stop_() {
  if (!this->mic_enabled_.exchange(false)) return;
  this->mic_source_->stop();
}

void FridayClient::on_mic_data_(const std::vector<uint8_t> &data) {
  if (!this->mic_enabled_ || data.empty()) return;
  if (xRingbufferSend(this->mic_rb_, data.data(), data.size(), 0) == pdTRUE) return;
  // Full: drop the oldest audio, then retry once.
  size_t n;
  void *p = xRingbufferReceiveUpTo(this->mic_rb_, &n, 0, data.size());
  if (p != nullptr) vRingbufferReturnItem(this->mic_rb_, p);
  xRingbufferSend(this->mic_rb_, data.data(), data.size(), 0);
}

void FridayClient::sender_task_trampoline_(void *arg) { static_cast<FridayClient *>(arg)->sender_task_(); }

void FridayClient::sender_task_() {
  std::vector<uint8_t> chunk;
  chunk.reserve(32000);
  for (;;) {
    size_t want = this->send_chunk_bytes_;
    chunk.clear();
    // Gather up to one chunk, but flush whatever we have after ~chunk duration.
    TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(want / 32);
    while (chunk.size() < want) {
      TickType_t now = xTaskGetTickCount();
      TickType_t wait = (deadline > now) ? (deadline - now) : 0;
      size_t n = 0;
      void *p = xRingbufferReceiveUpTo(this->mic_rb_, &n, wait ? wait : pdMS_TO_TICKS(50), want - chunk.size());
      if (p == nullptr) break;
      chunk.insert(chunk.end(), static_cast<uint8_t *>(p), static_cast<uint8_t *>(p) + n);
      vRingbufferReturnItem(this->mic_rb_, p);
    }
    if (chunk.empty() || !this->connected_ || !this->mic_enabled_) continue;

    if (xSemaphoreTake(this->client_mutex_, pdMS_TO_TICKS(100)) != pdTRUE) continue;
    if (this->client_ != nullptr && esp_websocket_client_is_connected(this->client_)) {
      int sent = esp_websocket_client_send_bin(this->client_, reinterpret_cast<const char *>(chunk.data()),
                                               chunk.size(), pdMS_TO_TICKS(500));
      if (sent < 0) ESP_LOGW(TAG, "send failed");
    }
    xSemaphoreGive(this->client_mutex_);
  }
}

}  // namespace esphome::friday_client
