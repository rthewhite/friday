#include "friday_client.h"

#include "esphome/core/application.h"
#include "esphome/core/hal.h"
#include "esphome/core/log.h"
#include "esphome/core/preferences.h"
#include "esphome/components/json/json_util.h"
#include "esphome/components/network/util.h"

#include <esp_heap_caps.h>
#include <esp_random.h>
#include <mbedtls/sha256.h>
#include <sdkconfig.h>
#ifdef CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
#include <esp_crt_bundle.h>
#endif
#include <algorithm>
#include <cmath>
#include <cstring>

namespace esphome::friday_client {

static const char *const TAG = "friday_client";

// Two seconds of 16 kHz s16le mono. Oldest audio is dropped when it fills.
static constexpr size_t MIC_RB_BYTES = 64000;
// Gemini streams replies two to three times faster than real time and the socket task must
// never block (it would starve the microphone sender), so the queue has to hold most of a
// long reply: ~65 s of 24 kHz s16le mono, in PSRAM.
static constexpr size_t PLAY_RB_BYTES = 3 * 1024 * 1024;
static constexpr TickType_t PLAY_WAIT = pdMS_TO_TICKS(100);
struct PlayItem {
  uint32_t gen;
  uint8_t data[];
};
static constexpr uint8_t WS_OP_TEXT = 0x1, WS_OP_BINARY = 0x2, WS_OP_CLOSE = 0x8;
// The control events the device acts on (turn_complete, interrupted, closed) are a few dozen bytes.
static constexpr int MAX_TEXT_BYTES = 4096;
// Friday's close code for a device whose key is waiting to be accepted in the portal.
static constexpr uint16_t CLOSE_PENDING_APPROVAL = 4403;
// Friday's close code for an alert session whose alert no longer rings (answered or cancelled elsewhere).
static constexpr uint16_t CLOSE_ALERT_GONE = 4410;
// Control connection: messages are a few dozen bytes. Reconnects back off from 1 s to 60 s, and wait 60 s after a
// close that won't change by retrying sooner (4401 revoked, 4403 not accepted yet, 4409 replaced by another).
static constexpr int MAX_CONTROL_BYTES = 512;
static constexpr uint32_t CONTROL_BACKOFF_MIN_MS = 1000;
static constexpr uint32_t CONTROL_BACKOFF_MAX_MS = 60000;
// A connection that stayed open this long resets the backoff.
static constexpr uint32_t CONTROL_STABLE_MS = 30000;
// The local ring repeats the chime (~220 ms) this often.
static constexpr uint32_t RING_PERIOD_MS = 1000;
// Alert ids are short base32 strings Friday made; anything else in a control message is ignored.
static bool valid_alert_id(const char *id) {
  if (id == nullptr) return false;
  size_t n = strlen(id);
  if (n == 0 || n > 16) return false;
  for (size_t i = 0; i < n; i++) {
    if (!((id[i] >= 'a' && id[i] <= 'z') || (id[i] >= '0' && id[i] <= '9'))) return false;
  }
  return true;
}

// The device key in NVS, under a fixed id so renaming the node keeps it. Bump the version to force a new key.
struct KeyBlob {
  uint8_t version;
  uint8_t bytes[32];
};
static constexpr uint8_t KEY_VERSION = 1;

const char *state_name(State s) {
  switch (s) {
    case State::IDLE: return "idle";
    case State::CONNECTING: return "connecting";
    case State::LISTENING: return "listening";
    case State::SPEAKING: return "speaking";
    case State::ERROR: return "error";
    case State::PENDING: return "pending";
    case State::RINGING: return "ringing";
  }
  return "?";
}

/// Unpadded base64url, as Friday's key format expects.
static std::string base64url(const uint8_t *data, size_t len) {
  static const char *const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string out;
  out.reserve((len * 4 + 2) / 3);
  for (size_t i = 0; i < len; i += 3) {
    uint32_t n = uint32_t(data[i]) << 16;
    if (i + 1 < len) n |= uint32_t(data[i + 1]) << 8;
    if (i + 2 < len) n |= data[i + 2];
    out += ALPHABET[(n >> 18) & 63];
    out += ALPHABET[(n >> 12) & 63];
    if (i + 1 < len) out += ALPHABET[(n >> 6) & 63];
    if (i + 2 < len) out += ALPHABET[n & 63];
  }
  return out;
}

/// First 8 hex characters of the key's SHA-256, as `xxxx-xxxx` (the portal derives the same from its stored hash).
static std::string fingerprint_of(const std::string &key) {
  uint8_t digest[32];
  mbedtls_sha256(reinterpret_cast<const unsigned char *>(key.data()), key.size(), digest, 0);
  char buf[10];
  snprintf(buf, sizeof(buf), "%02x%02x-%02x%02x", digest[0], digest[1], digest[2], digest[3]);
  return buf;
}

// ------------------------------------------------------------------ lifecycle

bool FridayClient::load_or_create_key_() {
  ESPPreferenceObject pref = global_preferences->make_preference<KeyBlob>(fnv1_hash(std::string("friday_client.key")), true);
  KeyBlob blob{};
  if (!pref.load(&blob) || blob.version != KEY_VERSION) {
    // Runs after Wi-Fi setup, so the radio is on and esp_fill_random draws from the hardware RNG.
    blob.version = KEY_VERSION;
    esp_fill_random(blob.bytes, sizeof(blob.bytes));
    // Write it now rather than at the next preference flush, so a power cut cannot lose a key Friday has seen.
    if (!pref.save(&blob) || !global_preferences->sync()) {
      ESP_LOGE(TAG, "could not store the device key");
      return false;
    }
    ESP_LOGI(TAG, "generated a new device key");
  }
  this->key_ = base64url(blob.bytes, sizeof(blob.bytes));
  this->fingerprint_ = fingerprint_of(this->key_);
  this->headers_ = "Authorization: Bearer " + this->key_ + "\r\n";
  return true;
}

void FridayClient::setup() {
  if (this->device_id_.empty()) this->device_id_ = App.get_name();
  if (!this->load_or_create_key_()) {
    this->mark_failed();
    return;
  }
  ESP_LOGI(TAG, "device %s, key fingerprint %s", this->device_id_.c_str(), this->fingerprint_.c_str());
  this->client_mutex_ = xSemaphoreCreateMutex();
  this->ctrl_mutex_ = xSemaphoreCreateMutex();
  // The control connection's url: configured, or the session url with /ws/audio replaced by /ws/device.
  std::string base = this->control_url_;
  if (base.empty()) {
    static const std::string AUDIO = "/ws/audio";
    size_t q = this->url_.find('?');
    std::string path = this->url_.substr(0, q), rest = q == std::string::npos ? "" : this->url_.substr(q);
    if (path.size() >= AUDIO.size() && path.compare(path.size() - AUDIO.size(), AUDIO.size(), AUDIO) == 0) {
      base = path.substr(0, path.size() - AUDIO.size()) + "/ws/device" + rest;
    }
  }
  if (base.empty()) {
    ESP_LOGW(TAG, "url does not end in /ws/audio and no control_url is set: Friday can't ring this device");
    this->ctrl_disabled_ = true;
  } else {
    this->ctrl_uri_ = base + ((base.find('?') == std::string::npos) ? "?device=" : "&device=") + this->device_id_;
  }
  this->mic_rb_ = xRingbufferCreateWithCaps(MIC_RB_BYTES, RINGBUF_TYPE_BYTEBUF, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (this->mic_rb_ == nullptr) this->mic_rb_ = xRingbufferCreate(MIC_RB_BYTES, RINGBUF_TYPE_BYTEBUF);
  if (this->mic_rb_ == nullptr) {
    ESP_LOGE(TAG, "could not allocate microphone buffer");
    this->mark_failed();
    return;
  }
  this->play_rb_ = xRingbufferCreateWithCaps(PLAY_RB_BYTES, RINGBUF_TYPE_NOSPLIT, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (this->play_rb_ == nullptr) {
    ESP_LOGE(TAG, "could not allocate playback buffer");
    this->mark_failed();
    return;
  }
  this->mic_source_->add_data_callback([this](const std::vector<uint8_t> &d) { this->on_mic_data_(d); });
  xTaskCreate(FridayClient::sender_task_trampoline_, "friday_send", 4096, this, 5, &this->sender_task_handle_);
  xTaskCreate(FridayClient::player_task_trampoline_, "friday_play", 4096, this, 6, &this->player_task_handle_);
  ESP_LOGI(TAG, "buffers allocated, free PSRAM %u KB", (unsigned) (heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024));
}

void FridayClient::dump_config() {
  ESP_LOGCONFIG(TAG, "Friday client:\n  URL: %s\n  Control URL: %s\n  Device id: %s\n  Key fingerprint: %s\n  Send chunk: %u bytes\n  Barge-in delay: %u ms\n  Ring limit: %u s",
                this->url_.c_str(), this->ctrl_disabled_ ? "(none)" : this->ctrl_uri_.c_str(), this->device_id_.c_str(),
                this->fingerprint_.c_str(), (unsigned) this->send_chunk_bytes_, (unsigned) this->barge_in_delay_ms_,
                (unsigned) (this->ring_limit_ms_ / 1000));
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

  this->ctrl_loop_(now);

  // An alert session that ended before any audio: the alert no longer rings, or Friday can't be heard.
  switch (this->alert_failure_.exchange(AlertFailure::NONE)) {
    case AlertFailure::GONE:
      ESP_LOGI(TAG, "alert %s no longer rings", this->alert_id_.c_str());
      this->request_teardown_();
      this->go_idle_();
      break;
    case AlertFailure::FAILED:
      ESP_LOGW(TAG, "could not open the alert session, ringing locally");
      this->request_teardown_();
      this->ring_local_(this->alert_id_);
      break;
    default:
      break;
  }

  switch (this->get_state()) {
    case State::CONNECTING:
      if (now - this->connect_started_at_ > this->connect_timeout_ms_) {
        if (this->alert_session_) {
          ESP_LOGW(TAG, "alert session: connect timeout, ringing locally");
          this->request_teardown_();
          this->ring_local_(this->alert_id_);
        } else {
          this->fail_("connect timeout");
        }
      }
      break;
    case State::RINGING:
      if (now - this->ring_started_at_ > this->ring_limit_ms_) {
        ESP_LOGI(TAG, "nobody stopped the ringing, giving up");
        this->stop_ringing(false);
      } else if (int32_t(now - this->ring_next_chime_at_) >= 0 && !this->playback_pending_()) {
        this->chime();
        this->ring_next_chime_at_ = now + RING_PERIOD_MS;
      }
      break;
    case State::SPEAKING:
      if (this->turn_done_ && !this->playback_pending_()) {
        this->turn_done_ = false;
        this->set_state_(State::LISTENING);
      }
      break;
    case State::ERROR:
    case State::PENDING:
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
  if (this->muted_()) {
    ESP_LOGW(TAG, "microphone is muted, not starting");
    this->error();
    return;
  }
  this->alert_id_.clear();
  this->alert_session_ = false;
  this->begin_session_();
}

void FridayClient::begin_session_() {
  this->user_stopping_ = false;
  this->draining_ = false;
  this->turn_done_ = false;
  this->text_acc_.clear();
  this->got_audio_ = false;
  this->alert_failure_ = AlertFailure::NONE;
  this->connect_started_at_ = millis();
  this->set_state_(State::CONNECTING);
  if (this->connect_()) return;
  if (this->alert_session_) {
    this->request_teardown_();
    this->ring_local_(this->alert_id_);
  } else {
    this->fail_("could not create websocket client");
  }
}

void FridayClient::stop() {
  const State s = this->get_state();
  if (s == State::IDLE) return;
  if (s == State::RINGING) {
    this->stop_ringing(true);
    return;
  }
  // The button ended an alert session: whatever Friday was saying, the user reacted.
  if (this->alert_session_.exchange(false)) this->ctrl_send_("acknowledged", this->alert_id_);
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
  if (this->get_state() == State::RINGING) return;  // the button stops the ringing instead
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

void FridayClient::pending_() {
  ESP_LOGW(TAG, "Friday has not accepted this device yet: accept %s (fingerprint %s) under Settings > Voice devices",
           this->device_id_.c_str(), this->fingerprint_.c_str());
  this->mic_stop_();
  this->speaker_flush_();
  this->draining_ = false;
  this->request_teardown_();
  this->error_since_ = millis();
  this->set_state_(State::PENDING);
}

void FridayClient::go_idle_() {
  this->mic_stop_();
  this->alert_session_ = false;
  this->alert_id_.clear();
  this->set_state_(State::IDLE);
}

// ------------------------------------------------------------------ websocket

bool FridayClient::connect_() {
  std::string uri = this->url_;
  uri += (uri.find('?') == std::string::npos) ? "?device=" : "&device=";
  uri += this->device_id_;
  if (this->alert_session_) {
    uri += "&alert=";
    uri += this->alert_id_;
  }
  this->close_code_ = 0;
  esp_websocket_client_config_t cfg = {};
  cfg.uri = uri.c_str();
  cfg.headers = this->headers_.c_str();
  // wss:// verifies the server against the bundled public CAs; the key is only sent once that succeeded.
  // The component requests the bundle for wss:// urls (see __init__.py).
#ifdef CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
  if (uri.rfind("wss://", 0) == 0) cfg.crt_bundle_attach = esp_crt_bundle_attach;
#endif
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
        // Only the small control events matter here. Larger messages (tool results, transcripts) are skipped
        // without buffering: they would need one contiguous block of internal RAM, and a failed allocation aborts.
        if (d->payload_len > MAX_TEXT_BYTES) {
          if (d->payload_offset == 0) ESP_LOGD(TAG, "ignoring a %d-byte text message", d->payload_len);
          this->text_acc_.clear();
          break;
        }
        if (d->payload_offset == 0) this->text_acc_.clear();
        this->text_acc_.append(d->data_ptr, d->data_len);
        if (d->payload_offset + d->data_len >= d->payload_len) {
          this->on_text_frame_(this->text_acc_);
          this->text_acc_.clear();
        }
      } else if (op == WS_OP_CLOSE) {
        // Payload: 2-byte big-endian close code, then the reason.
        if (d->data_len >= 2) {
          const auto *p = reinterpret_cast<const uint8_t *>(d->data_ptr);
          this->close_code_ = uint16_t(p[0] << 8 | p[1]);
          ESP_LOGD(TAG, "server closed the connection: %u %.*s", (unsigned) this->close_code_.load(), d->data_len - 2, d->data_ptr + 2);
        } else {
          ESP_LOGD(TAG, "server sent close frame");
        }
      }
      break;
    }

    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_ERROR:
    case WEBSOCKET_EVENT_CLOSED:
      if (this->connected_.exchange(false) || this->get_state() == State::CONNECTING) {
        // Expected when we asked for it or Friday said goodbye; otherwise an error.
        if (!this->user_stopping_ && !this->draining_) {
          if (this->alert_session_ && !this->got_audio_) {
            // Nothing of the alert was heard: loop() goes idle (4410) or rings locally (anything else).
            this->alert_failure_ = this->close_code_ == CLOSE_ALERT_GONE ? AlertFailure::GONE : AlertFailure::FAILED;
          } else if (this->close_code_ == CLOSE_PENDING_APPROVAL) this->pending_();
          else if (this->close_code_ == 4401) this->fail_("unauthorized: this device is revoked, or sent no key");
          else if (this->close_code_ == 4400) this->fail_("bad device: Friday does not accept this device id or key format");
          else this->fail_(event_id == WEBSOCKET_EVENT_ERROR ? "connection error" : "connection lost");
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

// ------------------------------------------------------------------ control connection

bool FridayClient::ctrl_connect_() {
  esp_websocket_client_config_t cfg = {};
  cfg.uri = this->ctrl_uri_.c_str();
  cfg.headers = this->headers_.c_str();
#ifdef CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
  if (this->ctrl_uri_.rfind("wss://", 0) == 0) cfg.crt_bundle_attach = esp_crt_bundle_attach;
#endif
  cfg.buffer_size = 1024;
  cfg.task_stack = 8192;  // the TLS handshake runs on this task, as for sessions
  cfg.disable_auto_reconnect = true;
  cfg.network_timeout_ms = this->connect_timeout_ms_;
  // Friday pings every 20 s; our own pings notice a server that vanished without closing.
  cfg.ping_interval_sec = 15;
  cfg.pingpong_timeout_sec = 45;
  this->ctrl_close_code_ = 0;
  this->ctrl_connected_at_ = 0;
  this->ctrl_acc_.clear();
  this->ctrl_client_ = esp_websocket_client_init(&cfg);
  if (this->ctrl_client_ == nullptr) return false;
  esp_websocket_register_events(this->ctrl_client_, WEBSOCKET_EVENT_ANY, FridayClient::ctrl_event_trampoline_, this);
  if (esp_websocket_client_start(this->ctrl_client_) != ESP_OK) {
    esp_websocket_client_destroy(this->ctrl_client_);
    this->ctrl_client_ = nullptr;
    return false;
  }
  ESP_LOGD(TAG, "control: connecting to %s", this->ctrl_uri_.c_str());
  return true;
}

void FridayClient::ctrl_event_trampoline_(void *arg, esp_event_base_t, int32_t event_id, void *event_data) {
  static_cast<FridayClient *>(arg)->on_ctrl_event_(event_id, static_cast<esp_websocket_event_data_t *>(event_data));
}

/// Runs on the control client's task: only flags and the inbox, everything else happens in loop().
void FridayClient::on_ctrl_event_(int32_t event_id, esp_websocket_event_data_t *d) {
  switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
      this->ctrl_connected_ = true;
      this->ctrl_connected_at_ = millis() | 1;  // never 0, which means "never opened"
      ESP_LOGI(TAG, "control connection open: Friday can reach this device (free internal heap %u KB, largest block %u KB)",
               (unsigned) (heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
               (unsigned) (heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL) / 1024));
      break;

    case WEBSOCKET_EVENT_DATA: {
      uint8_t op = d->op_code;
      if (op == 0x0) op = this->ctrl_last_opcode_;
      else this->ctrl_last_opcode_ = op;
      if (op == WS_OP_TEXT) {
        if (d->payload_len > MAX_CONTROL_BYTES) {
          if (d->payload_offset == 0) ESP_LOGW(TAG, "control: ignoring a %d-byte message", d->payload_len);
          this->ctrl_acc_.clear();
          break;
        }
        if (d->payload_offset == 0) this->ctrl_acc_.clear();
        this->ctrl_acc_.append(d->data_ptr, d->data_len);
        if (d->payload_offset + d->data_len >= d->payload_len) {
          xSemaphoreTake(this->ctrl_mutex_, portMAX_DELAY);
          if (this->ctrl_inbox_.size() < 16) this->ctrl_inbox_.push_back(this->ctrl_acc_);
          xSemaphoreGive(this->ctrl_mutex_);
          this->ctrl_acc_.clear();
        }
      } else if (op == WS_OP_CLOSE && d->data_len >= 2) {
        const auto *p = reinterpret_cast<const uint8_t *>(d->data_ptr);
        this->ctrl_close_code_ = uint16_t(p[0] << 8 | p[1]);
      }
      break;
    }

    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_ERROR:
    case WEBSOCKET_EVENT_CLOSED:
      this->ctrl_connected_ = false;
      this->ctrl_ended_ = true;
      break;

    default:
      break;
  }
}

void FridayClient::ctrl_loop_(uint32_t now) {
  if (this->ctrl_disabled_) return;

  std::vector<std::string> inbox;
  xSemaphoreTake(this->ctrl_mutex_, portMAX_DELAY);
  inbox.swap(this->ctrl_inbox_);
  xSemaphoreGive(this->ctrl_mutex_);
  for (const auto &msg : inbox) this->on_ctrl_message_(msg);

  if (this->ctrl_ended_.exchange(false) && this->ctrl_client_ != nullptr) {
    // Not from the client's own task: destroy it here, then plan the next attempt.
    esp_websocket_client_destroy(this->ctrl_client_);
    this->ctrl_client_ = nullptr;
    this->ctrl_connected_ = false;
    const uint16_t code = this->ctrl_close_code_.exchange(0);
    const uint32_t opened = this->ctrl_connected_at_.exchange(0);
    uint32_t wait;
    if (code == 4401 || code == 4403 || code == 4409) {
      if (code == 4403) {
        ESP_LOGW(TAG, "Friday has not accepted this device yet: accept %s (fingerprint %s) under Settings > Voice devices",
                 this->device_id_.c_str(), this->fingerprint_.c_str());
      } else {
        ESP_LOGW(TAG, "control connection closed by Friday (%u), retrying in a minute", (unsigned) code);
      }
      wait = CONTROL_BACKOFF_MAX_MS;
    } else {
      if (opened != 0 && now - opened > CONTROL_STABLE_MS) this->ctrl_backoff_ms_ = 0;
      this->ctrl_backoff_ms_ = this->ctrl_backoff_ms_ == 0 ? CONTROL_BACKOFF_MIN_MS
                                                           : std::min(this->ctrl_backoff_ms_ * 2, CONTROL_BACKOFF_MAX_MS);
      wait = this->ctrl_backoff_ms_;
      ESP_LOGI(TAG, "control connection lost, reconnecting in %u s", (unsigned) (wait / 1000));
    }
    this->ctrl_next_attempt_at_ = now + wait;
  }

  if (this->ctrl_client_ == nullptr && network::is_connected() && int32_t(now - this->ctrl_next_attempt_at_) >= 0) {
    if (!this->ctrl_connect_()) {
      this->ctrl_backoff_ms_ = std::min(std::max(this->ctrl_backoff_ms_ * 2, CONTROL_BACKOFF_MIN_MS), CONTROL_BACKOFF_MAX_MS);
      this->ctrl_next_attempt_at_ = now + this->ctrl_backoff_ms_;
      ESP_LOGW(TAG, "could not create the control connection");
    }
  }
}

void FridayClient::on_ctrl_message_(const std::string &raw) {
  json::parse_json(raw, [this](JsonObject root) -> bool {
    const char *type = root["type"];
    const char *alert = root["data"]["alert"];
    if (type == nullptr || !valid_alert_id(alert)) return true;
    if (strcmp(type, "ring") == 0) this->on_ring_(alert);
    else if (strcmp(type, "stop") == 0) this->on_stop_(alert);
    return true;
  });
}

void FridayClient::ctrl_send_(const char *type, const std::string &alert) {
  if (this->ctrl_client_ == nullptr || !this->ctrl_connected_ || alert.empty()) {
    ESP_LOGD(TAG, "control: not connected, %s for %s not sent", type, alert.c_str());
    return;
  }
  char buf[96];
  int n = snprintf(buf, sizeof(buf), "{\"type\":\"%s\",\"alert\":\"%s\"}", type, alert.c_str());
  if (n <= 0 || n >= int(sizeof(buf))) return;
  if (esp_websocket_client_send_text(this->ctrl_client_, buf, n, pdMS_TO_TICKS(500)) < 0) ESP_LOGW(TAG, "control: could not send %s", type);
}

// ------------------------------------------------------------------ alerts

void FridayClient::on_ring_(const std::string &alert) {
  const State s = this->get_state();
  if (s == State::RINGING) {
    this->ring_local_(alert);
    return;
  }
  if (s != State::IDLE) {
    ESP_LOGI(TAG, "ring for %s while busy, ignored", alert.c_str());
    return;
  }
  if (this->muted_()) {
    ESP_LOGI(TAG, "ring for %s while muted, ringing locally", alert.c_str());
    this->ring_local_(alert);
    return;
  }
  ESP_LOGI(TAG, "ring for %s, opening the alert session", alert.c_str());
  this->alert_id_ = alert;
  this->alert_session_ = true;
  this->begin_session_();
}

void FridayClient::on_stop_(const std::string &alert) {
  // An alert session keeps going: Friday says stop once the user answered, and the conversation continues.
  if (this->get_state() != State::RINGING) return;
  auto it = std::find(this->ring_ids_.begin(), this->ring_ids_.end(), alert);
  if (it == this->ring_ids_.end()) return;
  this->ring_ids_.erase(it);
  if (this->ring_ids_.empty()) {
    ESP_LOGI(TAG, "Friday stopped the ringing");
    this->speaker_flush_();
    this->go_idle_();
  }
}

void FridayClient::ring_local_(std::string alert) {
  if (this->get_state() != State::RINGING) {
    this->mic_stop_();
    this->speaker_flush_();
    this->draining_ = false;
    this->alert_session_ = false;
    this->alert_id_.clear();
    this->ring_ids_.clear();
    this->ring_started_at_ = millis();
    this->ring_next_chime_at_ = this->ring_started_at_;
    this->set_state_(State::RINGING);
  }
  if (alert.empty() || std::find(this->ring_ids_.begin(), this->ring_ids_.end(), alert) != this->ring_ids_.end()) return;
  ESP_LOGI(TAG, "ringing %s locally", alert.c_str());
  this->ring_ids_.push_back(alert);
  this->ctrl_send_("ringing_locally", alert);
}

void FridayClient::stop_ringing(bool acknowledged) {
  if (this->get_state() != State::RINGING) return;
  ESP_LOGI(TAG, "ringing stopped (%s)", acknowledged ? "acknowledged" : "unanswered");
  for (const auto &id : this->ring_ids_) this->ctrl_send_(acknowledged ? "acknowledged" : "unanswered", id);
  this->ring_ids_.clear();
  this->speaker_flush_();
  this->go_idle_();
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

bool FridayClient::enqueue_audio_(const uint8_t *data, size_t len) {
  // Never block here: callers run in the websocket task or the main loop.
  void *slot = nullptr;
  if (xRingbufferSendAcquire(this->play_rb_, &slot, sizeof(PlayItem) + len, 0) != pdTRUE) return false;
  auto *item = static_cast<PlayItem *>(slot);
  item->gen = this->play_gen_.load();
  memcpy(item->data, data, len);
  this->play_pending_ += len;
  xRingbufferSendComplete(this->play_rb_, slot);
  return true;
}

void FridayClient::on_audio_frame_(const uint8_t *data, size_t len) {
  this->got_audio_ = true;
  if (this->draining_ || this->user_stopping_) return;
  if (this->get_state() == State::LISTENING) {
    this->turn_done_ = false;
    this->speaking_since_ = millis();
    this->set_state_(State::SPEAKING);
  }
  if (!this->enqueue_audio_(data, len)) {
    uint32_t now = millis();
    if (now - this->drop_warn_at_ > 1000) {
      this->drop_warn_at_ = now;
      ESP_LOGW(TAG, "playback queue full, dropped %u bytes", (unsigned) len);
    }
  }
}

// Two rising tones, ~220 ms total at 24 kHz mono s16le, with short fades so it
// does not click. Pushed through the normal queue so it plays in order with speech.
void FridayClient::chime() {
  static constexpr uint32_t RATE = 24000;
  static constexpr float FREQ[2] = {880.0f, 1174.66f};  // A5, D6
  static constexpr uint32_t TONE_SAMPLES = RATE * 110 / 1000;
  static constexpr uint32_t FADE = RATE * 8 / 1000;
  static constexpr float AMP = 0.35f * 32767.0f;
  std::vector<int16_t> pcm(TONE_SAMPLES * 2);
  for (uint32_t t = 0; t < 2; t++) {
    for (uint32_t i = 0; i < TONE_SAMPLES; i++) {
      float env = 1.0f;
      if (i < FADE) env = float(i) / FADE;
      else if (i > TONE_SAMPLES - FADE) env = float(TONE_SAMPLES - i) / FADE;
      pcm[t * TONE_SAMPLES + i] = int16_t(AMP * env * sinf(2.0f * float(M_PI) * FREQ[t] * i / RATE));
    }
  }
  const auto *bytes = reinterpret_cast<const uint8_t *>(pcm.data());
  const size_t total = pcm.size() * sizeof(int16_t);
  // Queue items must stay well under the ring buffer's max item size.
  for (size_t off = 0; off < total; off += 4096) {
    if (!this->enqueue_audio_(bytes + off, std::min<size_t>(4096, total - off))) {
      ESP_LOGW(TAG, "chime dropped, playback queue full");
      return;
    }
  }
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
  // Barge-in guard: right after a reply starts, the echo canceller has not converged and
  // Friday's own voice leaks through loud enough for Gemini to treat it as an interruption.
  // Keep the stream flowing but send silence for the first barge_in_delay.
  if (this->get_state() == State::SPEAKING && this->barge_in_delay_ms_ > 0 &&
      millis() - this->speaking_since_.load() < this->barge_in_delay_ms_) {
    static std::vector<uint8_t> silence;
    if (silence.size() < data.size()) silence.assign(data.size(), 0);
    if (xRingbufferSend(this->mic_rb_, silence.data(), data.size(), 0) == pdTRUE) return;
    return;
  }
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
