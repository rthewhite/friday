#pragma once

// Minimal test harness for the host-compiled firmware tests (esphome/test/run.sh).

#include <cstdio>
#include <cstdlib>

inline int &test_failures() {
  static int n = 0;
  return n;
}

#define CHECK(cond)                                                       \
  do {                                                                    \
    if (!(cond)) {                                                        \
      std::fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
      test_failures()++;                                                  \
    }                                                                     \
  } while (0)

#define TEST(name) static void name()
#define RUN(name)                      \
  do {                                 \
    int before = test_failures();      \
    name();                            \
    std::printf("%s %s\n", test_failures() == before ? "ok  " : "FAIL", #name); \
  } while (0)

inline int test_result() {
  if (test_failures() > 0)
    std::fprintf(stderr, "%d check(s) failed\n", test_failures());
  return test_failures() == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
