#include "test.h"
#include "xvf3800/xvf3800_protocol.h"

#include <vector>

using namespace esphome::xvf3800::protocol;

TEST(write_frame) {
  uint8_t payload[2] = {GPO_AMP, 0};
  uint8_t out[8];
  size_t n = build_write(GPO_WRITE_VALUE, payload, 2, out, sizeof(out));
  CHECK(n == 5);
  CHECK(out[0] == 20 && out[1] == 1 && out[2] == 2 && out[3] == 31 && out[4] == 0);
}

TEST(read_request) {
  uint8_t out[3];
  build_read_request(VERSION, out);
  CHECK(out[0] == 48 && out[1] == 0x80 && out[2] == 4);
  CHECK(read_size(VERSION) == 4);

  build_read_request(GPO_READ_VALUES, out);
  CHECK(out[0] == 20 && out[1] == 0x80 && out[2] == 6);
}

TEST(led_ring_frame) {
  uint32_t colors[RING_LEDS] = {0xFF0000, 0x00FF00, 0x0000FF, 0xFF123456};
  uint8_t payload[RING_LEDS * 4];
  pack_ring(colors, payload);
  uint8_t out[MAX_FRAME];
  size_t n = build_write(LED_RING_COLOR, payload, sizeof(payload), out, sizeof(out));
  CHECK(n == 51);
  CHECK(out[0] == 20 && out[1] == 19 && out[2] == 48);
  // little-endian 0x00RRGGBB
  CHECK(out[3] == 0x00 && out[4] == 0x00 && out[5] == 0xFF && out[6] == 0x00);
  CHECK(out[7] == 0x00 && out[8] == 0xFF && out[9] == 0x00);
  CHECK(out[11] == 0xFF && out[12] == 0x00);
  // the unused top byte is cleared
  CHECK(out[15] == 0x56 && out[16] == 0x34 && out[17] == 0x12 && out[18] == 0x00);
  CHECK(out[50] == 0x00);
}

TEST(led_settings_frames) {
  uint8_t value = LED_EFFECT_RING;
  uint8_t out[4];
  CHECK(build_write(LED_EFFECT, &value, 1, out, sizeof(out)) == 4);
  CHECK(out[0] == 20 && out[1] == 12 && out[2] == 1 && out[3] == 5);
  value = 0;
  CHECK(build_write(LED_GAMMIFY, &value, 1, out, sizeof(out)) == 4);
  CHECK(out[0] == 20 && out[1] == 14 && out[2] == 1 && out[3] == 0);
}

TEST(int32_payload) {
  uint8_t v[4];
  put_i32(1, v);
  CHECK(v[0] == 1 && v[1] == 0 && v[2] == 0 && v[3] == 0);
  put_i32(-30, v);
  CHECK(get_u32(v) == 0xFFFFFFE2u);
  uint8_t out[8];
  CHECK(build_write(PP_AGCONOFF, v, 4, out, sizeof(out)) == 7);
  CHECK(out[0] == 17 && out[1] == 10 && out[2] == 4);
}

TEST(status_codes) {
  CHECK(classify_status(0) == Status::DONE);
  CHECK(classify_status(1) == Status::RETRY);
  CHECK(classify_status(0x40) == Status::RETRY);
  CHECK(classify_status(3) == Status::ERROR);
  CHECK(classify_status(0xFF) == Status::ERROR);
}

TEST(version_parsing) {
  uint8_t ok[4] = {0, 1, 0, 9};
  Version v;
  CHECK(parse_version(ok, 4, v));
  CHECK(v == SUPPORTED_VERSION);

  uint8_t old[4] = {0, 1, 0, 7};
  CHECK(parse_version(old, 4, v));
  CHECK(v != SUPPORTED_VERSION);
  CHECK(v.patch == 7);

  uint8_t busy[4] = {0x40, 1, 0, 9};
  CHECK(!parse_version(busy, 4, v));
  CHECK(!parse_version(ok, 3, v));
}

TEST(refuses_bad_frames) {
  // over one XVF3800 transfer
  static constexpr Command BIG{1, 1, 58};
  std::vector<uint8_t> payload(58, 0);
  uint8_t out[64];
  CHECK(build_write(BIG, payload.data(), payload.size(), out, sizeof(out)) == 0);
  // payload size not the command's
  uint8_t two[2] = {30, 1};
  CHECK(build_write(LED_EFFECT, two, 2, out, sizeof(out)) == 0);
  // output buffer too small
  CHECK(build_write(GPO_WRITE_VALUE, two, 2, out, 4) == 0);
}

int main() {
  RUN(write_frame);
  RUN(read_request);
  RUN(led_ring_frame);
  RUN(led_settings_frames);
  RUN(int32_payload);
  RUN(status_codes);
  RUN(version_parsing);
  RUN(refuses_bad_frames);
  return test_result();
}
