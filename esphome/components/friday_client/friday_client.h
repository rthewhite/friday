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

/// PENDING: Friday answered 4403, this device's key is waiting to be accepted in the portal. Shown briefly, like ERROR.
/// RINGING: the device rings an alert with its own tone (Friday couldn't be heard, or the microphone is muted).
enum class State : uint8_t { IDLE = 0, CONNECTING, LISTENING, SPEAKING, ERROR, PENDING, RINGING };
const char *state_name(State s);

/**
 * Press-to-talk client for Friday's /ws/audio protocol.
 *
 * Identity: on first boot the device generates a random key and keeps it in flash (NVS), so it survives
 * power loss, OTA and reflashes; a factory reset makes a new one. The key goes in an `Authorization: Bearer`
 * header (never the URL or the log); its fingerprint (first 8 hex characters of its SHA-256) is logged and
 * exposed so the user can compare it with the portal before accepting the device.
 *
 * Control connection: while Wi-Fi is up the device keeps a second websocket open to Friday's /ws/device (no audio).
 * Friday sends `ring` when an alert (a timer) is due: the device opens a session with `&alert=<id>`, which starts
 * with a tone and Friday's announcement. When that session can't open, or the microphone is muted, the device rings
 * the alert with its own chime until the button stops it (acknowledged) or `ring_limit` passes (unanswered), and
 * reports which over the control connection. The control connection never changes the session state or the LEDs.
 *
 * Threads: ESPHome main loop (actions, state trigger, timers, control messages), the microphone
 * task (data callback -> ring buffer), a sender task (ring buffer -> socket)
 * and two esp_websocket_client tasks (session events and incoming audio -> speaker; control frames -> queue).
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
  /// Override the control connection's url; by default `url` with its trailing /ws/audio replaced by /ws/device.
  void set_control_url(const std::string &url) { this->control_url_ = url; }
  void set_ring_limit(uint32_t ms) { this->ring_limit_ms_ = ms; }

  /// Open a session (IDLE -> CONNECTING). No-op unless idle.
  void start();
  /// End the session from any state and return to IDLE. While ringing, stops the ringing as acknowledged.
  void stop();
  /// start() when idle, stop() otherwise (which also stops a local ring as acknowledged).
  void toggle();
  /// Stop ringing alerts locally, telling Friday they were `acknowledged` (a button) or `unanswered`. No-op unless ringing.
  void stop_ringing(bool acknowledged);
  bool is_ringing() const { return this->get_state() == State::RINGING; }
  /// The control connection to Friday is open: Friday can reach this device.
  bool is_online() const { return this->ctrl_connected_.load(); }
  /// Show the error state briefly (e.g. button pressed while muted).
  void error();
  /// Play a short two-tone chime through the playback queue (used on wake word detection).
  void chime();

  State get_state() const { return this->state_.load(); }
  /// `xxxx-xxxx`, as the portal shows it for this device's key. Empty until setup() ran.
  const std::string &get_key_fingerprint() const { return this->fingerprint_; }
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

  // --- identity ---
  bool load_or_create_key_();

  // --- sessions ---
  /// Open a session, as an alert session when `alert_id_` is set. Callers check the state and mute.
  void begin_session_();
  bool muted_() const { return this->mic_ != nullptr && this->mic_->get_mute_state(); }

  // --- control connection (its event task only queues; everything else runs in loop()) ---
  static void ctrl_event_trampoline_(void *arg, esp_event_base_t base, int32_t event_id, void *event_data);
  void on_ctrl_event_(int32_t event_id, esp_websocket_event_data_t *d);
  bool ctrl_connect_();
  void ctrl_loop_(uint32_t now);
  void on_ctrl_message_(const std::string &json);
  void ctrl_send_(const char *type, const std::string &alert);

  // --- alerts ---
  void on_ring_(const std::string &alert);
  void on_stop_(const std::string &alert);
  /// Ring `alert` with the device's own chime (adds it when already ringing). By value: callers pass alert_id_.
  void ring_local_(std::string alert);

  // --- state ---
  void set_state_(State s);
  void fail_(const char *why);
  void pending_();
  void go_idle_();

  microphone::MicrophoneSource *mic_source_{nullptr};
  microphone::Microphone *mic_{nullptr};
  speaker::Speaker *speaker_{nullptr};
  std::string url_;
  std::string device_id_;
  std::string key_;          // base64url, 43 characters; never logged
  std::string fingerprint_;
  std::string headers_;      // "Authorization: Bearer <key>\r\n", kept alive for the client
  std::atomic<uint16_t> close_code_{0};  // from the server's close frame, 0 when none
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
  uint32_t error_since_{0};  // also when PENDING was entered
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

  // --- alert session: what to do when it ends before any audio arrived (set by the session's event task) ---
  enum class AlertFailure : uint8_t { NONE = 0, GONE, FAILED };
  std::string alert_id_;  // the alert this session answers; empty for a normal session (main loop only)
  std::atomic<bool> alert_session_{false};  // alert_id_ is set, readable from the session's event task
  std::atomic<bool> got_audio_{false};
  std::atomic<AlertFailure> alert_failure_{AlertFailure::NONE};

  // --- local ringing (main loop only) ---
  std::vector<std::string> ring_ids_;
  uint32_t ring_limit_ms_{300000};
  uint32_t ring_started_at_{0};
  uint32_t ring_next_chime_at_{0};

  // --- control connection ---
  std::string control_url_;
  std::string ctrl_uri_;  // kept alive for the client
  esp_websocket_client_handle_t ctrl_client_{nullptr};
  std::atomic<bool> ctrl_connected_{false};
  std::atomic<bool> ctrl_ended_{false};        // the event task saw it close; loop() destroys and reconnects
  std::atomic<uint16_t> ctrl_close_code_{0};
  uint32_t ctrl_next_attempt_at_{0};
  uint32_t ctrl_backoff_ms_{0};
  std::atomic<uint32_t> ctrl_connected_at_{0};  // millis() of the last open, 0 when it never opened
  bool ctrl_disabled_{false};
  std::string ctrl_acc_;
  uint8_t ctrl_last_opcode_{0};
  SemaphoreHandle_t ctrl_mutex_{nullptr};      // guards ctrl_inbox_
  std::vector<std::string> ctrl_inbox_;
  std::vector<std::string> ctrl_outbox_;       // reports made while offline (main loop only)
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
template<typename... Ts> class StopRingingAction : public Action<Ts...>, public Parented<FridayClient> {
 public:
  void play(const Ts &...x) override { this->parent_->stop_ringing(true); }
};
template<typename... Ts> class IsRingingCondition : public Condition<Ts...>, public Parented<FridayClient> {
 public:
  bool check(const Ts &...x) override { return this->parent_->is_ringing(); }
};

}  // namespace esphome::friday_client
