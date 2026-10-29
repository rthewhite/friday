#pragma once

// The decisions friday_client makes about Friday's device protocol: which URIs it dials, which messages it acts on,
// what it sends back and how it shows its key. No ESPHome includes, so esphome/test/ can compile it on the host and
// check it against core's fixture (packages/core/test/fixtures/device-protocol.json). JSON parsing and SHA-256 stay
// with ESPHome and mbedtls in friday_client.cpp.

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

namespace esphome::friday_client::protocol {

/// Alert ids are short base32 strings Friday made; anything else in a control message is ignored.
inline bool valid_alert_id(const char *id) {
  if (id == nullptr) return false;
  size_t n = strlen(id);
  if (n == 0 || n > 16) return false;
  for (size_t i = 0; i < n; i++) {
    if (!((id[i] >= 'a' && id[i] <= 'z') || (id[i] >= '0' && id[i] <= '9'))) return false;
  }
  return true;
}

/// `url` with `device` (and `alert`, when not empty) added to its query: the /ws/audio session URI.
inline std::string audio_uri(const std::string &url, const std::string &device, const std::string &alert) {
  std::string uri = url;
  uri += (uri.find('?') == std::string::npos) ? "?device=" : "&device=";
  uri += device;
  if (!alert.empty()) {
    uri += "&alert=";
    uri += alert;
  }
  return uri;
}

/// The control connection's URI: `control_url`, or else `url` with /ws/audio replaced by /ws/device, with `device`
/// added. Empty when neither gives one, and then Friday can't ring the device.
inline std::string control_uri(const std::string &url, const std::string &control_url, const std::string &device) {
  std::string base = control_url;
  if (base.empty()) {
    static const std::string AUDIO = "/ws/audio";
    size_t q = url.find('?');
    std::string path = url.substr(0, q), rest = q == std::string::npos ? "" : url.substr(q);
    if (path.size() >= AUDIO.size() && path.compare(path.size() - AUDIO.size(), AUDIO.size(), AUDIO) == 0) {
      base = path.substr(0, path.size() - AUDIO.size()) + "/ws/device" + rest;
    }
  }
  if (base.empty()) return "";
  return base + ((base.find('?') == std::string::npos) ? "?device=" : "&device=") + device;
}

enum class AudioEvent { INTERRUPTED, TURN_COMPLETE, CLOSED, IGNORE };

/// What a /ws/audio text event's `type` asks of the device. A device gets only these three; the rest is for browsers.
inline AudioEvent audio_event(const char *type) {
  if (type == nullptr) return AudioEvent::IGNORE;
  if (strcmp(type, "interrupted") == 0) return AudioEvent::INTERRUPTED;
  if (strcmp(type, "turn_complete") == 0) return AudioEvent::TURN_COMPLETE;
  if (strcmp(type, "closed") == 0) return AudioEvent::CLOSED;
  return AudioEvent::IGNORE;
}

enum class ControlEvent { RING, STOP, IGNORE };

/// What a /ws/device message with this `type` and `data.alert` asks of the device.
inline ControlEvent control_event(const char *type, const char *alert) {
  if (type == nullptr || !valid_alert_id(alert)) return ControlEvent::IGNORE;
  if (strcmp(type, "ring") == 0) return ControlEvent::RING;
  if (strcmp(type, "stop") == 0) return ControlEvent::STOP;
  return ControlEvent::IGNORE;
}

/// Longest report the device sends; a longer one is not sent.
static constexpr size_t MAX_CONTROL_MESSAGE = 95;

/// The device's report on an alert (`ringing_locally`, `acknowledged`, `unanswered`), or empty when there is no
/// alert or the message would be too long.
inline std::string control_message(const char *type, const std::string &alert) {
  if (alert.empty()) return "";
  char buf[MAX_CONTROL_MESSAGE + 1];
  int n = snprintf(buf, sizeof(buf), "{\"type\":\"%s\",\"alert\":\"%s\"}", type, alert.c_str());
  if (n <= 0 || n >= int(sizeof(buf))) return "";
  return std::string(buf, n);
}

/// The key's fingerprint from its SHA-256: the first 8 hex characters as `xxxx-xxxx`, as the portal shows it.
inline std::string format_fingerprint(const uint8_t digest[32]) {
  char buf[10];
  snprintf(buf, sizeof(buf), "%02x%02x-%02x%02x", digest[0], digest[1], digest[2], digest[3]);
  return buf;
}

}  // namespace esphome::friday_client::protocol
