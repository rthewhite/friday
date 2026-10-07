#include "xvf3800.h"

#include "esphome/core/hal.h"
#include "esphome/core/log.h"

namespace esphome::xvf3800 {

static const char *const TAG = "xvf3800";

// The XVF3800 boots alongside the ESP32 and may not answer for a few seconds after power-on.
static constexpr uint32_t PROBE_INTERVAL_MS = 250;
static constexpr uint32_t PROBE_TIMEOUT_MS = 10000;
static constexpr uint32_t MUTE_POLL_MS = 100;
// This many failed polls in a row means the XVF3800 has reset (or gone): probe and configure it again.
static constexpr uint8_t MAX_POLL_FAILURES = 3;
static constexpr int READ_ATTEMPTS = 10;
static constexpr uint32_t READ_RETRY_MS = 2;

using namespace protocol;

void XVF3800::setup() {
  this->mute_pref_ = global_preferences->make_preference<bool>(fnv1_hash("xvf3800_mute"));
  bool stored = false;
  if (this->mute_pref_.load(&stored))
    this->muted_ = stored;
  this->probe_started_ = millis();
}

void XVF3800::loop() {
  uint32_t now = millis();
  if (this->state_ == State::PROBING) {
    if (now - this->last_probe_ < PROBE_INTERVAL_MS)
      return;
    this->last_probe_ = now;
    if (this->probe_()) {
      if (this->configure_()) {
        this->state_ = State::READY;
        this->poll_failures_ = 0;
        this->status_ = str_sprintf("%u.%u.%u", this->version_.major, this->version_.minor, this->version_.patch);
        this->status_clear_warning();
        ESP_LOGI(TAG, "XVF3800 firmware %s ready", this->status_.c_str());
        this->ready_cb_.call();
        return;
      }
      // Its servicer may still be starting; try again until the probe window ends.
      ESP_LOGW(TAG, "XVF3800 answered but could not be configured yet");
    }
    if (this->state_ == State::PROBING && now - this->probe_started_ > PROBE_TIMEOUT_MS) {
      this->state_ = State::FAILED;
      if (this->answered_) {
        this->status_ = "configuration failed";
        ESP_LOGE(TAG, "XVF3800 answered but could not be configured");
        this->status_set_error(LOG_STR("configuration failed"));
      } else {
        this->status_ = "not responding on I2C";
        ESP_LOGE(TAG,
                 "XVF3800 not responding at 0x%02X. It may still run its USB firmware: flash "
                 "respeaker_xvf3800_i2s_master_v1.0.9_48k.bin as described in the README",
                 this->address_);
        this->status_set_error(LOG_STR("not responding on I2C"));
      }
    }
    return;
  }
  if (this->state_ == State::READY && now - this->last_poll_ >= MUTE_POLL_MS) {
    this->last_poll_ = now;
    this->poll_mute_();
  }
}

bool XVF3800::probe_() {
  uint8_t payload[VERSION.bytes];
  if (!this->read_cmd_(VERSION, payload))
    return false;
  this->answered_ = true;
  this->version_ = parse_version(payload);
  if (this->version_ != SUPPORTED_VERSION) {
    this->state_ = State::FAILED;
    this->status_ = str_sprintf("unsupported firmware %u.%u.%u (needs %u.%u.%u)", this->version_.major,
                                this->version_.minor, this->version_.patch, SUPPORTED_VERSION.major,
                                SUPPORTED_VERSION.minor, SUPPORTED_VERSION.patch);
    ESP_LOGE(TAG, "XVF3800 runs %u.%u.%u; this firmware needs %u.%u.%u (see the README to flash it)",
             this->version_.major, this->version_.minor, this->version_.patch, SUPPORTED_VERSION.major,
             SUPPORTED_VERSION.minor, SUPPORTED_VERSION.patch);
    this->status_set_error(LOG_STR("unsupported XVF3800 firmware"));
    return false;
  }
  return true;
}

bool XVF3800::configure_() {
  bool ok = true;
  // The ASR category only carries beams when the ASR output is on.
  if (this->left_.category == CATEGORY_ASR || this->right_.category == CATEGORY_ASR)
    ok &= this->write_i32_(AEC_ASROUTONOFF, 1);
  uint8_t left[2] = {this->left_.category, this->left_.source};
  uint8_t right[2] = {this->right_.category, this->right_.source};
  ok &= this->write_cmd_(AUDIO_MGR_OP_L, left, 2);
  ok &= this->write_cmd_(AUDIO_MGR_OP_R, right, 2);
  ok &= this->write_i32_(PP_AGCONOFF, this->agc_ ? 1 : 0);
  ok &= this->write_gpo_(GPO_AMP, 0);
  ok &= this->write_gpo_(GPO_LED_POWER, 1);
  if (this->ring_used_) {
    uint8_t effect = LED_EFFECT_RING;
    ok &= this->write_cmd_(LED_EFFECT, &effect, 1);
    // The light already applies ESPHome's gamma; a second correction on the chip turns dim colours off.
    uint8_t gammify = 0;
    ok &= this->write_cmd_(LED_GAMMIFY, &gammify, 1);
  }
  // Mute wins: a press made while only the ESP32 restarted is still on GPO 30, and after a power-on, when the
  // chip starts unmuted, the saved state applies.
  uint8_t gpo[GPO_READ_VALUES.bytes];
  bool pressed = this->read_cmd_(GPO_READ_VALUES, gpo) && gpo[GPO_INDEX_MUTE] != 0 && !this->muted_;
  if (pressed)
    this->muted_ = true;
  ok &= this->write_gpo_(GPO_MUTE, this->muted_ ? 1 : 0);
  if (ok)
    this->mute_changed_(this->muted_, pressed);
  return ok;
}

void XVF3800::poll_mute_() {
  uint8_t gpo[GPO_READ_VALUES.bytes];
  if (!this->read_cmd_(GPO_READ_VALUES, gpo)) {
    this->status_set_warning(LOG_STR("cannot read the mute state"));
    if (++this->poll_failures_ >= MAX_POLL_FAILURES) {
      // It forgets every setting on reset, so treat it as a fresh boot.
      ESP_LOGW(TAG, "XVF3800 stopped answering; probing and configuring it again");
      this->state_ = State::PROBING;
      this->status_ = "starting";
      this->answered_ = false;
      this->probe_started_ = millis();
    }
    return;
  }
  this->poll_failures_ = 0;
  this->status_clear_warning();
  bool muted = gpo[GPO_INDEX_MUTE] != 0;
  if (muted != this->muted_)
    this->mute_changed_(muted, true);
}

void XVF3800::set_mute(bool muted) {
  if (!this->is_ready()) {
    ESP_LOGW(TAG, "XVF3800 not ready, cannot %s", muted ? "mute" : "unmute");
    return;
  }
  if (!this->write_gpo_(GPO_MUTE, muted ? 1 : 0)) {
    ESP_LOGW(TAG, "%s failed", muted ? "Mute" : "Unmute");
    return;
  }
  if (muted != this->muted_)
    this->mute_changed_(muted, true);
}

void XVF3800::mute_changed_(bool muted, bool save) {
  this->muted_ = muted;
  ESP_LOGI(TAG, "Microphones %s", muted ? "muted" : "unmuted");
  if (save) {
    // Synced at once so the state survives a power cut right after the press.
    this->mute_pref_.save(&muted);
    global_preferences->sync();
  }
  this->mute_cb_.call(muted);
}

bool XVF3800::write_ring(const uint32_t colors[RING_LEDS]) {
  if (!this->is_ready())
    return false;
  uint8_t payload[RING_LEDS * 4];
  pack_ring(colors, payload);
  ESP_LOGV(TAG, "Ring: LED 0 %06" PRIX32 ", LED 6 %06" PRIX32, colors[0], colors[6]);
  return this->write_cmd_(LED_RING_COLOR, payload, sizeof(payload));
}

bool XVF3800::write_cmd_(const Command &c, const uint8_t *payload, size_t len) {
  uint8_t frame[MAX_FRAME];
  size_t n = build_write(c, payload, len, frame, sizeof(frame));
  if (n == 0) {
    ESP_LOGE(TAG, "Bad frame for %u/%u", c.resid, c.cmd);
    return false;
  }
  auto err = this->write(frame, n);
  if (err != i2c::ERROR_OK) {
    ESP_LOGW(TAG, "Write %u/%u failed: %d", c.resid, c.cmd, (int) err);
    return false;
  }
  return true;
}

bool XVF3800::write_i32_(const Command &c, int32_t v) {
  uint8_t payload[4];
  put_i32(v, payload);
  return this->write_cmd_(c, payload, 4);
}

bool XVF3800::write_gpo_(uint8_t pin, uint8_t level) {
  uint8_t payload[2] = {pin, level};
  return this->write_cmd_(GPO_WRITE_VALUE, payload, 2);
}

bool XVF3800::read_cmd_(const Command &c, uint8_t *out) {
  uint8_t request[3];
  build_read_request(c, request);
  uint8_t resp[MAX_FRAME];
  const size_t n = read_size(c);
  for (int attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    if (this->write(request, 3) != i2c::ERROR_OK || this->read(resp, n) != i2c::ERROR_OK)
      return false;
    switch (classify_status(resp[0])) {
      case Status::DONE:
        memcpy(out, resp + 1, c.bytes);
        return true;
      case Status::RETRY:
        delay(READ_RETRY_MS);
        continue;
      case Status::ERROR:
        ESP_LOGW(TAG, "Read %u/%u: status 0x%02X", c.resid, c.cmd, resp[0]);
        return false;
    }
  }
  ESP_LOGW(TAG, "Read %u/%u: still busy after %d attempts", c.resid, c.cmd, READ_ATTEMPTS);
  return false;
}

void XVF3800::dump_config() {
  ESP_LOGCONFIG(TAG,
                "XVF3800:\n"
                "  Status: %s\n"
                "  Left output: category %u, source %u\n"
                "  Right output: category %u, source %u\n"
                "  AGC: %s\n"
                "  Muted: %s",
                this->status_.c_str(), this->left_.category, this->left_.source, this->right_.category,
                this->right_.source, YESNO(this->agc_), YESNO(this->muted_));
  LOG_I2C_DEVICE(this);
}

}  // namespace esphome::xvf3800
