#pragma once

// Reads core's device protocol fixture (packages/core/test/fixtures/device-protocol.json) for the host tests.
// Only its shape: a top-level object whose values are strings or arrays of flat objects, whose values are strings
// or booleans. Anything else stops the test run with a message, so a fixture change that breaks the shape is loud.

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace fixture {

struct Value {
  bool is_bool = false;
  bool b = false;
  std::string s;
};
using Entry = std::map<std::string, Value>;
using Fixture = std::map<std::string, std::vector<Entry>>;

[[noreturn]] inline void fail(const std::string &what, size_t at) {
  std::fprintf(stderr, "fixture: %s at byte %zu\n", what.c_str(), at);
  std::exit(2);
}

class Reader {
 public:
  explicit Reader(std::string text) : t_(std::move(text)) {}

  Fixture read() {
    Fixture out;
    expect('{');
    if (peek() == '}') fail("empty fixture", i_);
    for (;;) {
      std::string key = string();
      expect(':');
      if (peek() == '"') {
        string();  // a top-level note such as "about"
      } else {
        out[key] = entries();
      }
      if (peek() == ',') { i_++; continue; }
      expect('}');
      break;
    }
    if (peek() != '\0') fail("text after the fixture", i_);
    return out;
  }

 private:
  std::vector<Entry> entries() {
    std::vector<Entry> list;
    expect('[');
    if (peek() == ']') { i_++; return list; }
    for (;;) {
      list.push_back(entry());
      if (peek() == ',') { i_++; continue; }
      expect(']');
      return list;
    }
  }

  Entry entry() {
    Entry e;
    expect('{');
    for (;;) {
      std::string key = string();
      expect(':');
      Value v;
      char c = peek();
      if (c == '"') {
        v.s = string();
      } else if (t_.compare(i_, 4, "true") == 0) {
        v.is_bool = v.b = true;
        i_ += 4;
      } else if (t_.compare(i_, 5, "false") == 0) {
        v.is_bool = true;
        i_ += 5;
      } else {
        fail("expected a string or boolean for \"" + key + "\"", i_);
      }
      e[key] = v;
      if (peek() == ',') { i_++; continue; }
      expect('}');
      return e;
    }
  }

  std::string string() {
    expect('"');
    std::string s;
    while (i_ < t_.size() && t_[i_] != '"') {
      char c = t_[i_++];
      if (c != '\\') { s += c; continue; }
      if (i_ >= t_.size()) break;
      char esc = t_[i_++];
      switch (esc) {
        case '"': s += '"'; break;
        case '\\': s += '\\'; break;
        case '/': s += '/'; break;
        case 'n': s += '\n'; break;
        case 't': s += '\t'; break;
        default: fail(std::string("unsupported escape \\") + esc, i_ - 2);
      }
    }
    if (i_ >= t_.size()) fail("unterminated string", i_);
    i_++;
    return s;
  }

  char peek() {
    while (i_ < t_.size() && (t_[i_] == ' ' || t_[i_] == '\n' || t_[i_] == '\r' || t_[i_] == '\t')) i_++;
    return i_ < t_.size() ? t_[i_] : '\0';
  }

  void expect(char c) {
    if (peek() != c) fail(std::string("expected '") + c + "'", i_);
    i_++;
  }

  std::string t_;
  size_t i_ = 0;
};

inline Fixture load(const char *path) {
  std::ifstream in(path);
  if (!in) {
    std::fprintf(stderr, "fixture: cannot read %s\n", path);
    std::exit(2);
  }
  std::stringstream ss;
  ss << in.rdbuf();
  return Reader(ss.str()).read();
}

/// A string field; an entry without it stops the run, so a renamed field in the fixture is caught.
inline const std::string &str(const Entry &e, const char *key) {
  auto it = e.find(key);
  if (it == e.end() || it->second.is_bool) {
    std::fprintf(stderr, "fixture: entry has no string \"%s\"\n", key);
    std::exit(2);
  }
  return it->second.s;
}

/// A boolean field, false when absent.
inline bool flag(const Entry &e, const char *key) {
  auto it = e.find(key);
  return it != e.end() && it->second.is_bool && it->second.b;
}

/// An optional string field, empty when absent.
inline std::string opt(const Entry &e, const char *key) {
  auto it = e.find(key);
  return it == e.end() || it->second.is_bool ? "" : it->second.s;
}

}  // namespace fixture
