#pragma once

#include "esphome/core/automation.h"
#include "esphome/core/component.h"
#include "esphome/core/helpers.h"
#include "esphome/components/microphone/microphone.h"
#include "esphome/components/microphone/microphone_source.h"
#include "esphome/components/speaker/speaker.h"

#include <esp_websocket_client.h>
#include <freertos/FreeRTOS.h>
#include <freertos/ringbuf.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include <atomic>
#include <string>
#include <vector>

namespace esphome::friday_client {

enum class State : uint8_t { IDLE = 0, CONNECTING, LISTENING, SPEAKING, ERROR };
const char *state_name(State s);

/**
 * Press-to-talk client for Friday's /ws/audio protocol.
 *
 * Threads: ESPHome main loop (actions, state trigger, timers), the microphone
 * task (data callback -> ring buffer), a sender task (ring buffer -> socket)
 * and the esp_websocket_client task (events, incoming audio -> speaker).
 * State is an atomic; the on_state trigger fires from loop().
 */
class FridayClient : public Component {
 public:
  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::AFTER_WIFI; }

  void set_microphone_source(microphone::MicrophoneSource *s) { this->mic_source_ = s; }
  void set_microphone(microphone::Microphone *m) { this->mic_ = m; }
  void set_speaker(speaker::Speaker *s) { this->speaker_ = s; }
  void set_url(const std::string &url) { this->url_ = url; }
  void set_device_id(const std::string &id) { this->device_id_ = id; }
  void set_connect_timeout(uint32_t ms) { this->connect_timeout_ms_ = ms; }
  void set_drain_timeout(uint32_t ms) { this->drain_timeout_ms_ = ms; }
  void set_error_hold(uint32_t ms) { this->error_hold_ms_ = ms; }
  void set_send_chunk_ms(uint32_t ms) { this->send_chunk_bytes_ = ms * 32; }  // 16 kHz * 2 bytes
  void set_barge_in_delay(uint32_t ms) { this->barge_in_delay_ms_ = ms; }

  /// Open a session (IDLE -> CONNECTING). No-op unless idle.
  void start();
  /// End the session from any state and return to IDLE.
  void stop();
  /// start() when idle, stop() otherwise.
  void toggle();
  /// Show the error state briefly (e.g. button pressed while muted).
  void error();
  /// Play a short two-tone chime through the playback queue (used on wake word detection).
  void chime();

  State get_state() const { return this->state_.load(); }
  bool is_active() const {
    auto s = this->get_state();
    return s == State::CONNECTING || s == State::LISTENING || s == State::SPEAKING;
  }
  void add_on_state_callback(std::function<void(std::string)> &&cb) { this->state_cb_.add(std::move(cb)); }

 protected:
  // --- websocket (runs in the client's task) ---
  static void ws_event_trampoline_(void *arg, esp_event_base_t base, int32_t event_id, void *event_data);
  void on_ws_event_(int32_t event_id, esp_websocket_event_data_t *d);
  void on_text_frame_(const std::string &json);
  void on_audio_frame_(const uint8_t *data, size_t len);
  bool enqueue_audio_(const uint8_t *data, size_t len);
  bool connect_();
  void request_teardown_();

  // --- microphone / sender ---
  void on_mic_data_(const std::vector<uint8_t> &data);
  static void sender_task_trampoline_(void *arg);
  void sender_task_();
  void mic_start_();
  void mic_stop_();

  // --- speaker (player task drains play_rb_ so the socket task never blocks) ---
  static void player_task_trampoline_(void *arg);
  void player_task_();
  void speaker_begin_();
  void speaker_flush_();
  bool playback_pending_() const { return this->play_pending_.load() > 0 || this->speaker_->has_buffered_data(); }

  // --- state ---
  void set_state_(State s);
  void fail_(const char *why);
  void go_idle_();

  microphone::MicrophoneSource *mic_source_{nullptr};
  microphone::Microphone *mic_{nullptr};
  speaker::Speaker *speaker_{nullptr};
  std::string url_;
  std::string device_id_;
  uint32_t connect_timeout_ms_{10000};
  uint32_t drain_timeout_ms_{5000};
  uint32_t error_hold_ms_{2000};
  size_t send_chunk_bytes_{3200};
  uint32_t barge_in_delay_ms_{1500};
  std::atomic<uint32_t> speaking_since_{0};

  std::atomic<State> state_{State::IDLE};
  std::atomic<bool> state_dirty_{false};
  CallbackManager<void(std::string)> state_cb_;

  esp_websocket_client_handle_t client_{nullptr};
  SemaphoreHandle_t client_mutex_{nullptr};
  std::atomic<bool> connected_{false};
  std::atomic<bool> teardown_requested_{false};
  std::atomic<bool> user_stopping_{false};
  std::atomic<bool> draining_{false};
  std::atomic<bool> turn_done_{false};
  std::atomic<bool> speaker_started_{false};
  uint32_t connect_started_at_{0};
  uint32_t drain_started_at_{0};
  uint32_t error_since_{0};
  uint32_t drop_warn_at_{0};

  RingbufHandle_t mic_rb_{nullptr};
  TaskHandle_t sender_task_handle_{nullptr};
  std::atomic<bool> mic_enabled_{false};

  RingbufHandle_t play_rb_{nullptr};
  TaskHandle_t player_task_handle_{nullptr};
  std::atomic<uint32_t> play_gen_{0};      // bumped on flush; queued items with an older gen are dropped
  std::atomic<size_t> play_pending_{0};    // bytes queued but not yet handed to the speaker

  // Text frames may be fragmented; binary continuation frames carry no opcode.
  std::string text_acc_;
  uint8_t last_opcode_{0};
};

class StateTrigger : public Trigger<std::string> {
 public:
  explicit StateTrigger(FridayClient *c) {
    c->add_on_state_callback([this](std::string s) { this->trigger(std::move(s)); });
  }
};

template<typename... Ts> class StartAction : public Action<Ts...>, public Parented<FridayClient> {
 public:
  void play(const Ts &...x) override { this->parent_->start(); }
};
template<typename... Ts> class StopAction : public Action<Ts...>, public Parented<FridayClient> {
 public:
  void play(const Ts &...x) override { this->parent_->stop(); }
};
template<typename... Ts> class ToggleAction : public Action<Ts...>, public Parented<FridayClient> {
 public:
  void play(const Ts &...x) override { this->parent_->toggle(); }
};
template<typename... Ts> class ErrorAction : public Action<Ts...>, public Parented<FridayClient> {
 public:
  void play(const Ts &...x) override { this->parent_->error(); }
};
template<typename... Ts> class ChimeAction : public Action<Ts...>, public Parented<FridayClient> {
 public:
  void play(const Ts &...x) override { this->parent_->chime(); }
};

}  // namespace esphome::friday_client
