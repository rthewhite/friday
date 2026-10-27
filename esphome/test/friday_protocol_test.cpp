// friday_client's protocol decisions against core's fixture (run.sh passes its path). Core's
// packages/core/test/device-protocol.test.ts checks the same file from the server's side.

#include "test.h"
#include "fixture.h"
#include "friday_client/friday_protocol.h"

#include <string>

using namespace esphome::friday_client::protocol;

static fixture::Fixture fx;

static const char *audio_name(AudioEvent e) {
  switch (e) {
    case AudioEvent::INTERRUPTED: return "interrupted";
    case AudioEvent::TURN_COMPLETE: return "turn_complete";
    case AudioEvent::CLOSED: return "closed";
    case AudioEvent::IGNORE: return "ignore";
  }
  return "?";
}

static const char *control_name(ControlEvent e) {
  switch (e) {
    case ControlEvent::RING: return "ring";
    case ControlEvent::STOP: return "stop";
    case ControlEvent::IGNORE: return "ignore";
  }
  return "?";
}

static bool check(bool ok, const std::string &what) {
  if (!ok) std::fprintf(stderr, "  mismatch: %s\n", what.c_str());
  return ok;
}

TEST(server_messages_mean_what_core_means) {
  CHECK(!fx["serverMessages"].empty());
  for (const auto &m : fx["serverMessages"]) {
    const std::string &type = fixture::str(m, "type"), &raw = fixture::str(m, "raw"), &meaning = fixture::str(m, "meaning");
    // The device reads `type` (and `data.alert`) from this text; make sure the fixture's fields are really in it.
    CHECK(check(raw.find("\"type\":\"" + type + "\"") != std::string::npos, raw));
    if (fixture::str(m, "channel") == "audio") {
      CHECK(check(meaning == audio_name(audio_event(type.c_str())), type + " -> " + meaning));
    } else {
      std::string alert = fixture::str(m, "alert");
      CHECK(check(raw.find("\"data\":{\"alert\":\"" + alert + "\"}") != std::string::npos, raw));
      CHECK(check(meaning == control_name(control_event(type.c_str(), alert.c_str())), type + "/" + alert + " -> " + meaning));
    }
  }
  CHECK(audio_event(nullptr) == AudioEvent::IGNORE);
  CHECK(control_event("ring", nullptr) == ControlEvent::IGNORE);
  CHECK(control_event(nullptr, "k7m2") == ControlEvent::IGNORE);
}

TEST(device_messages_are_built_exactly) {
  CHECK(!fx["deviceMessages"].empty());
  for (const auto &m : fx["deviceMessages"]) {
    std::string built = control_message(fixture::str(m, "type").c_str(), fixture::str(m, "alert"));
    CHECK(check(built == fixture::str(m, "raw"), built + " vs " + fixture::str(m, "raw")));
  }
  CHECK(control_message("acknowledged", "").empty());
  CHECK(control_message("acknowledged", std::string(100, 'a')).empty());
}

TEST(uris_are_built_exactly) {
  CHECK(!fx["uris"].empty());
  for (const auto &u : fx["uris"]) {
    const std::string &base = fixture::str(u, "base"), &device = fixture::str(u, "device");
    std::string audio = audio_uri(base, device, fixture::opt(u, "alert"));
    CHECK(check(audio == fixture::str(u, "audio"), audio));
    std::string control = control_uri(base, "", device);
    CHECK(check(control == fixture::opt(u, "control"), "control for " + base + ": " + control));
  }
  // A configured control_url wins over the one derived from url.
  CHECK(control_uri("wss://a/ws/audio", "wss://b/ctl?x=1", "d") == "wss://b/ctl?x=1&device=d");
}

TEST(alert_ids_are_checked_as_core_expects) {
  CHECK(!fx["alertIds"].empty());
  for (const auto &a : fx["alertIds"]) {
    const std::string &id = fixture::str(a, "id");
    CHECK(check(valid_alert_id(id.c_str()) == fixture::flag(a, "valid"), "alert id \"" + id + "\""));
  }
  CHECK(!valid_alert_id(nullptr));
}

static uint8_t hex(char c) { return c <= '9' ? c - '0' : c - 'a' + 10; }

TEST(fingerprints_match_core) {
  CHECK(!fx["fingerprints"].empty());
  for (const auto &f : fx["fingerprints"]) {
    const std::string &sha = fixture::str(f, "sha256");
    CHECK(sha.size() == 64);
    uint8_t digest[32];
    for (size_t i = 0; i < 32; i++) digest[i] = uint8_t(hex(sha[2 * i]) << 4 | hex(sha[2 * i + 1]));
    std::string fp = format_fingerprint(digest);
    CHECK(check(fp == fixture::str(f, "fingerprint"), fp));
  }
}

int main(int argc, char **argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: friday_protocol_test <device-protocol.json>\n");
    return 2;
  }
  fx = fixture::load(argv[1]);
  RUN(server_messages_mean_what_core_means);
  RUN(device_messages_are_built_exactly);
  RUN(uris_are_built_exactly);
  RUN(alert_ids_are_checked_as_core_expects);
  RUN(fingerprints_match_core);
  return test_result();
}
