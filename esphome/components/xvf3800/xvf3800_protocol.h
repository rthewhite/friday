#pragma once

// XVF3800 control protocol over I2C, for the reSpeaker I2S firmware 1.0.9 only (ids differ between versions).
// No ESPHome includes, so esphome/test/ can compile it on the host.
//
// Write: [resid, cmd, payload length, payload...]
// Read:  write [resid, cmd | 0x80, payload length + 1], stop, then read [status, payload...]
// Ids from python_control/xvf_host.py in respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY.

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace esphome::xvf3800::protocol {

static constexpr uint8_t I2C_ADDRESS = 0x2C;
/// The XVF3800 accepts I2C transfers of at most 60 bytes.
static constexpr size_t MAX_FRAME = 60;
static constexpr uint8_t READ_FLAG = 0x80;

struct Command {
  uint8_t resid;
  uint8_t cmd;
  uint8_t bytes;  // payload size in bytes
};

static constexpr Command VERSION{48, 0, 3};
static constexpr Command GPO_READ_VALUES{20, 0, 5};  // X0D11, X0D30, X0D31, X0D33, X0D39
static constexpr Command GPO_WRITE_VALUE{20, 1, 2};  // [pin, level]
static constexpr Command LED_EFFECT{20, 12, 1};
static constexpr Command LED_RING_COLOR{20, 19, 48};  // 12 x uint32 little-endian, 0x00RRGGBB
static constexpr Command GPI_VALUE_ALL{36, 6, 4};
static constexpr Command GPI_EVENT_PENDING_ALL{36, 7, 4};
static constexpr Command MUTE_FUNCTION_ENABLE{36, 8, 1};
static constexpr Command AUDIO_MGR_OP_L{35, 15, 2};  // [category, source]
static constexpr Command AUDIO_MGR_OP_R{35, 19, 2};
static constexpr Command AEC_ASROUTONOFF{33, 35, 4};  // int32
static constexpr Command PP_AGCONOFF{17, 10, 4};      // int32

// GPO pins and their index in GPO_READ_VALUES.
static constexpr uint8_t GPO_MUTE = 30;       // high: mics muted, red LED on
static constexpr uint8_t GPO_AMP = 31;        // low: amplifier on
static constexpr uint8_t GPO_LED_POWER = 33;  // high: WS2812 ring powered
static constexpr size_t GPO_INDEX_MUTE = 1;
static constexpr size_t GPO_INDEX_AMP = 2;
static constexpr size_t GPO_INDEX_LED_POWER = 3;

static constexpr uint8_t LED_EFFECT_OFF = 0;
static constexpr uint8_t LED_EFFECT_RING = 5;
static constexpr size_t RING_LEDS = 12;

// AUDIO_MGR_OP categories (XMOS XVF3800 user guide) and the auto-select beam's source index.
static constexpr uint8_t CATEGORY_SILENCE = 0;
static constexpr uint8_t CATEGORY_PROCESSED = 6;  // post-processed beam: AEC, noise suppression, AGC
static constexpr uint8_t CATEGORY_ASR = 7;        // ASR beam when AEC_ASROUTONOFF is 1
static constexpr uint8_t SOURCE_AUTO_SELECT = 3;

enum class Status : uint8_t { DONE, RETRY, ERROR };

/// 0 is done; 1 (wait) and 0x40 (servicer busy) mean ask again; anything else failed.
inline Status classify_status(uint8_t status) {
  if (status == 0)
    return Status::DONE;
  if (status == 1 || status == 0x40)
    return Status::RETRY;
  return Status::ERROR;
}

/// Builds a write frame into out. Returns its length, or 0 when the payload doesn't match the command or the
/// frame wouldn't fit in out or in one XVF3800 transfer.
inline size_t build_write(const Command &c, const uint8_t *payload, size_t len, uint8_t *out, size_t out_cap) {
  size_t total = 3 + len;
  if (len != c.bytes || total > MAX_FRAME || total > out_cap)
    return 0;
  out[0] = c.resid;
  out[1] = c.cmd;
  out[2] = static_cast<uint8_t>(len);
  if (len > 0)
    std::memcpy(out + 3, payload, len);
  return total;
}

/// The three-byte request that precedes a read. The response is read_size(c) bytes.
inline void build_read_request(const Command &c, uint8_t out[3]) {
  out[0] = c.resid;
  out[1] = static_cast<uint8_t>(c.cmd | READ_FLAG);
  out[2] = static_cast<uint8_t>(c.bytes + 1);
}

inline size_t read_size(const Command &c) { return c.bytes + 1u; }

inline void put_i32(int32_t v, uint8_t out[4]) {
  auto u = static_cast<uint32_t>(v);
  for (int i = 0; i < 4; i++)
    out[i] = static_cast<uint8_t>(u >> (8 * i));
}

inline uint32_t get_u32(const uint8_t in[4]) {
  return uint32_t(in[0]) | (uint32_t(in[1]) << 8) | (uint32_t(in[2]) << 16) | (uint32_t(in[3]) << 24);
}

/// 12 colours as 0x00RRGGBB into the 48-byte LED_RING_COLOR payload.
inline void pack_ring(const uint32_t colors[RING_LEDS], uint8_t out[RING_LEDS * 4]) {
  for (size_t i = 0; i < RING_LEDS; i++) {
    uint32_t c = colors[i] & 0x00FFFFFF;
    for (int b = 0; b < 4; b++)
      out[i * 4 + b] = static_cast<uint8_t>(c >> (8 * b));
  }
}

struct Version {
  uint8_t major{0}, minor{0}, patch{0};
  bool operator==(const Version &o) const { return major == o.major && minor == o.minor && patch == o.patch; }
  bool operator!=(const Version &o) const { return !(*this == o); }
};

static constexpr Version SUPPORTED_VERSION{1, 0, 9};

/// Parses a VERSION response ([status, major, minor, patch]). False unless the status is done.
inline bool parse_version(const uint8_t *resp, size_t len, Version &out) {
  if (len < read_size(VERSION) || classify_status(resp[0]) != Status::DONE)
    return false;
  out = Version{resp[1], resp[2], resp[3]};
  return true;
}

}  // namespace esphome::xvf3800::protocol
