#include "xvf3800_light.h"

#include "esphome/core/hal.h"

#include <cstring>

namespace esphome::xvf3800 {

void XVF3800Light::write_state(light::LightState *state) {
  uint32_t now = millis();
  if (!this->hub_->is_ready()) {
    // Keep the change until the XVF3800 answers; drop it if it never will.
    if (this->hub_->is_starting()) {
      this->schedule_show();
    } else {
      this->mark_shown_();
    }
    return;
  }
  if (now - this->last_write_ < MIN_INTERVAL_MS) {
    // Try again on the next loop so the last change is never lost.
    this->schedule_show();
    return;
  }
  uint32_t colors[protocol::RING_LEDS];
  for (size_t i = 0; i < protocol::RING_LEDS; i++) {
    const uint8_t *p = &this->rgb_[i * 3];
    colors[i] = (uint32_t(p[0]) << 16) | (uint32_t(p[1]) << 8) | p[2];
  }
  this->mark_shown_();
  if (this->sent_valid_ && memcmp(colors, this->sent_, sizeof(colors)) == 0)
    return;
  this->last_write_ = now;
  if (this->hub_->write_ring(colors)) {
    memcpy(this->sent_, colors, sizeof(colors));
    this->sent_valid_ = true;
  } else {
    this->schedule_show();
  }
}

light::ESPColorView XVF3800Light::get_view_internal(int32_t index) const {
  uint8_t *led = const_cast<uint8_t *>(&this->rgb_[index * 3]);
  return {led, led + 1, led + 2, nullptr, const_cast<uint8_t *>(&this->effect_data_[index]), &this->correction_};
}

}  // namespace esphome::xvf3800
