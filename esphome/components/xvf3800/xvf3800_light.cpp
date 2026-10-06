#include "xvf3800_light.h"

#include "esphome/core/hal.h"

#include <cstring>

namespace esphome::xvf3800 {

void XVF3800Light::setup() {
  // The XVF3800 starts dark and forgets the colours when it resets: send the whole ring each time it is ready.
  this->hub_->add_on_ready_callback([this]() {
    this->sent_valid_ = false;
    this->write_failed_ = false;
    this->schedule_show();
  });
}

void XVF3800Light::write_state(light::LightState *state) {
  uint32_t now = millis();
  if (!this->hub_->is_ready()) {
    // The colours stay in the buffer; the ready callback sends them.
    this->mark_shown_();
    return;
  }
  if (now - this->last_write_ < (this->write_failed_ ? RETRY_INTERVAL_MS : MIN_INTERVAL_MS)) {
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
  this->write_failed_ = !this->hub_->write_ring(colors);
  if (this->write_failed_) {
    this->schedule_show();
  } else {
    memcpy(this->sent_, colors, sizeof(colors));
    this->sent_valid_ = true;
  }
}

light::ESPColorView XVF3800Light::get_view_internal(int32_t index) const {
  uint8_t *led = const_cast<uint8_t *>(&this->rgb_[index * 3]);
  return {led, led + 1, led + 2, nullptr, const_cast<uint8_t *>(&this->effect_data_[index]), &this->correction_};
}

}  // namespace esphome::xvf3800
