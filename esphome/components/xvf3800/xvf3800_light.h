#pragma once

#include "esphome/components/light/addressable_light.h"
#include "esphome/core/component.h"

#include "xvf3800.h"

namespace esphome::xvf3800 {

/// The ring as an addressable light. The XVF3800 drives the LEDs; this only sends it the colours.
class XVF3800Light : public light::AddressableLight {
 public:
  static constexpr uint32_t MIN_INTERVAL_MS = 50;
  /// After a failed write, wait this long before trying again.
  static constexpr uint32_t RETRY_INTERVAL_MS = 1000;

  void set_hub(XVF3800 *hub) { this->hub_ = hub; }

  void setup() override;
  void write_state(light::LightState *state) override;
  float get_setup_priority() const override { return setup_priority::DATA - 1.0f; }

  int32_t size() const override { return protocol::RING_LEDS; }
  light::LightTraits get_traits() override {
    auto traits = light::LightTraits();
    traits.set_supported_color_modes({light::ColorMode::RGB});
    return traits;
  }
  void clear_effect_data() override {
    for (auto &e : this->effect_data_)
      e = 0;
  }

 protected:
  light::ESPColorView get_view_internal(int32_t index) const override;

  XVF3800 *hub_{nullptr};
  uint8_t rgb_[protocol::RING_LEDS * 3]{};
  uint8_t effect_data_[protocol::RING_LEDS]{};
  uint32_t sent_[protocol::RING_LEDS]{};
  bool sent_valid_{false};
  uint32_t last_write_{0};
  bool write_failed_{false};
};

}  // namespace esphome::xvf3800
