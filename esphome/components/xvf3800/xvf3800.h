#pragma once

#include "esphome/core/automation.h"
#include "esphome/core/component.h"
#include "esphome/core/helpers.h"
#include "esphome/core/preferences.h"
#include "esphome/components/i2c/i2c.h"

#include "xvf3800_protocol.h"

#include <string>

namespace esphome::xvf3800 {

/**
 * The reSpeaker XVF3800 over I2C, for its I2S firmware 1.0.9 only.
 *
 * At boot it waits for the XVF3800 to answer (it boots alongside the ESP32), checks the firmware version and
 * applies the runtime settings the chip doesn't persist: output routing, AGC, amplifier, ring power, mute.
 * Anything other than 1.0.9, or no answer, leaves it not ready with a reason in get_status(); the device
 * configuration then refuses sessions.
 *
 * Mute is the XVF3800's: its Mute button toggles GPO 30 (mics cut, red LED on) natively. The hub polls GPO 30,
 * reports changes through on_mute, and keeps the last state in flash so it is restored after a restart.
 */
class XVF3800 : public Component, public i2c::I2CDevice {
 public:
  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::DATA; }

  void set_left(uint8_t category, uint8_t source) { this->left_ = {category, source}; }
  void set_right(uint8_t category, uint8_t source) { this->right_ = {category, source}; }
  void set_agc(bool agc) { this->agc_ = agc; }
  void set_ring_used(bool used) { this->ring_used_ = used; }

  bool is_ready() const { return this->state_ == State::READY; }
  /// Still waiting for the XVF3800 to answer at boot.
  bool is_starting() const { return this->state_ == State::PROBING; }
  /// "1.0.9" when ready, otherwise why not (shown as a diagnostic sensor).
  const std::string &get_status() const { return this->status_; }

  bool is_muted() const { return this->muted_; }
  void set_mute(bool muted);

  /// 12 colours as 0x00RRGGBB. Returns false when the XVF3800 isn't ready or the write failed.
  bool write_ring(const uint32_t colors[protocol::RING_LEDS]);

  void add_on_mute_callback(std::function<void(bool)> &&cb) { this->mute_cb_.add(std::move(cb)); }

 protected:
  enum class State : uint8_t { PROBING, READY, FAILED };
  struct Route {
    uint8_t category, source;
  };

  bool probe_();
  bool configure_();
  void poll_mute_();
  void mute_changed_(bool muted, bool save);

  bool write_cmd_(const protocol::Command &c, const uint8_t *payload, size_t len);
  bool write_i32_(const protocol::Command &c, int32_t v);
  bool write_gpo_(uint8_t pin, uint8_t level);
  /// Reads c's payload into out (c.bytes long), retrying while the XVF3800 answers busy.
  bool read_cmd_(const protocol::Command &c, uint8_t *out);

  State state_{State::PROBING};
  std::string status_{"starting"};
  protocol::Version version_{};
  uint32_t probe_started_{0};
  uint32_t last_probe_{0};
  uint32_t last_poll_{0};

  Route left_{protocol::CATEGORY_PROCESSED, protocol::SOURCE_AUTO_SELECT};
  Route right_{protocol::CATEGORY_ASR, protocol::SOURCE_AUTO_SELECT};
  bool agc_{false};
  bool ring_used_{false};

  bool muted_{false};
  ESPPreferenceObject mute_pref_;
  CallbackManager<void(bool)> mute_cb_;
};

class MuteTrigger : public Trigger<bool> {
 public:
  explicit MuteTrigger(XVF3800 *parent) {
    parent->add_on_mute_callback([this](bool muted) { this->trigger(muted); });
  }
};

template<typename... Ts> class MuteAction : public Action<Ts...>, public Parented<XVF3800> {
 public:
  void play(const Ts &...x) override { this->parent_->set_mute(true); }
};

template<typename... Ts> class UnmuteAction : public Action<Ts...>, public Parented<XVF3800> {
 public:
  void play(const Ts &...x) override { this->parent_->set_mute(false); }
};

}  // namespace esphome::xvf3800
