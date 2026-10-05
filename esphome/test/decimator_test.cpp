#include "test.h"
#include "decimating/decimator.h"

#include <cmath>
#include <cstdio>
#include <random>
#include <vector>

using esphome::decimating::Decimator;
using esphome::decimating::design_lowpass;

// The parameters the ESPHome platform uses (design decision 3).
static constexpr size_t TAPS = 175;
static constexpr double CUTOFF = 7500.0;
static constexpr double BETA = 5.65;
static constexpr double RATE = 48000.0;

static Decimator make(size_t channels) { return Decimator(channels, 3, design_lowpass(TAPS, CUTOFF, RATE, BETA)); }

/// Gain in dB for a tone at freq_hz through the decimator (RMS out / RMS in, after the filter settles).
static double tone_gain_db(double freq_hz) {
  const size_t frames = 48000;
  const double amp = 0.5 * 2147483647.0;
  std::vector<int32_t> in(frames);
  for (size_t i = 0; i < frames; i++)
    in[i] = static_cast<int32_t>(amp * std::sin(2.0 * M_PI * freq_hz * double(i) / RATE + 0.3));
  Decimator d = make(1);
  std::vector<int32_t> out(d.max_output_frames(frames));
  size_t n = d.process(in.data(), frames, out.data());
  double sum = 0.0;
  size_t count = 0;
  for (size_t i = TAPS; i < n; i++) {  // skip the start-up transient
    sum += double(out[i]) * double(out[i]);
    count++;
  }
  double rms_out = std::sqrt(sum / double(count));
  double rms_in = amp / std::sqrt(2.0);
  return rms_out <= 0.0 ? -300.0 : 20.0 * std::log10(rms_out / rms_in);
}

TEST(passband_ripple) {
  double lo = 1e9, hi = -1e9;
  for (double f = 100.0; f <= 7000.0; f += 100.0) {
    double g = tone_gain_db(f);
    lo = std::fmin(lo, g);
    hi = std::fmax(hi, g);
  }
  std::printf("     passband 0.1-7 kHz: %.4f .. %.4f dB\n", lo, hi);
  CHECK(hi - lo <= 0.5);
  CHECK(std::fabs(hi) <= 0.25 && std::fabs(lo) <= 0.25);
}

TEST(stopband_attenuation) {
  double worst = -1e9;
  for (double f = 8050.0; f < 24000.0; f += 100.0)
    worst = std::fmax(worst, tone_gain_db(f));
  std::printf("     stopband 8-24 kHz: worst %.1f dB\n", worst);
  CHECK(worst <= -50.0);
}

TEST(tone_at_12k_does_not_fold_to_4k) {
  double g = tone_gain_db(12000.0);
  std::printf("     12 kHz tone: %.1f dB\n", g);
  CHECK(g <= -50.0);
}

TEST(rate_is_one_third) {
  Decimator d = make(2);
  std::vector<int32_t> in(2 * 4800, 0), out(2 * d.max_output_frames(4800));
  CHECK(d.process(in.data(), 4800, out.data()) == 1600);
}

TEST(block_splitting_does_not_change_output) {
  const size_t frames = 9000, ch = 2;
  std::mt19937 rng(42);
  std::uniform_int_distribution<int32_t> dist(INT32_MIN / 2, INT32_MAX / 2);
  std::vector<int32_t> in(frames * ch);
  for (auto &s : in)
    s = dist(rng);

  Decimator whole = make(ch);
  std::vector<int32_t> expected(ch * whole.max_output_frames(frames));
  size_t n = whole.process(in.data(), frames, expected.data());
  expected.resize(n * ch);

  for (size_t piece : {size_t(1), size_t(7), size_t(641)}) {
    Decimator d = make(ch);
    std::vector<int32_t> got;
    std::vector<int32_t> buf(ch * d.max_output_frames(piece));
    for (size_t at = 0; at < frames; at += piece) {
      size_t len = std::min(piece, frames - at);
      size_t m = d.process(&in[at * ch], len, buf.data());
      got.insert(got.end(), buf.begin(), buf.begin() + m * ch);
    }
    CHECK(got == expected);
  }
}

TEST(channels_are_independent) {
  const size_t frames = 4800;
  std::vector<int32_t> in(frames * 2);
  for (size_t i = 0; i < frames; i++) {
    in[2 * i] = static_cast<int32_t>(1e9 * std::sin(2.0 * M_PI * 1000.0 * double(i) / RATE));
    in[2 * i + 1] = 0;
  }
  Decimator d = make(2);
  std::vector<int32_t> out(2 * d.max_output_frames(frames));
  size_t n = d.process(in.data(), frames, out.data());
  bool left_has_signal = false, right_silent = true;
  for (size_t i = 0; i < n; i++) {
    left_has_signal |= out[2 * i] != 0;
    right_silent &= out[2 * i + 1] == 0;
  }
  CHECK(left_has_signal);
  CHECK(right_silent);
}

TEST(full_scale_clips_instead_of_wrapping) {
  const size_t frames = 3000;
  std::vector<int32_t> in(frames, INT32_MAX);
  Decimator d = make(1);
  std::vector<int32_t> out(d.max_output_frames(frames));
  size_t n = d.process(in.data(), frames, out.data());
  for (size_t i = TAPS; i < n; i++)
    CHECK(out[i] > INT32_MAX - 4096);
  std::fill(in.begin(), in.end(), INT32_MIN);
  d.reset();
  n = d.process(in.data(), frames, out.data());
  for (size_t i = TAPS; i < n; i++)
    CHECK(out[i] < INT32_MIN + 4096);
}

int main() {
  RUN(passband_ripple);
  RUN(stopband_attenuation);
  RUN(tone_at_12k_does_not_fold_to_4k);
  RUN(rate_is_one_third);
  RUN(block_splitting_does_not_change_output);
  RUN(channels_are_independent);
  RUN(full_scale_clips_instead_of_wrapping);
  return test_result();
}
