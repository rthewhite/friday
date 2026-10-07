#pragma once

// Integer-factor decimation of interleaved 32-bit PCM through a Kaiser-windowed-sinc low-pass FIR.
// No ESPHome includes, so esphome/test/ can compile it on the host.

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace esphome::decimating {

/// Zeroth-order modified Bessel function of the first kind, by its power series.
inline double bessel_i0(double x) {
  double sum = 1.0, term = 1.0, q = x * x / 4.0;
  for (int k = 1; k < 64; k++) {
    term *= q / (double(k) * double(k));
    sum += term;
    if (term < sum * 1e-12)
      break;
  }
  return sum;
}

/// Linear-phase low-pass taps (odd count) with unity gain at DC.
inline std::vector<float> design_lowpass(size_t taps, double cutoff_hz, double rate_hz, double beta) {
  std::vector<double> h(taps);
  const double fc = cutoff_hz / rate_hz;  // cycles per sample
  const double mid = (double(taps) - 1.0) / 2.0;
  const double i0_beta = bessel_i0(beta);
  double sum = 0.0;
  for (size_t n = 0; n < taps; n++) {
    double m = double(n) - mid;
    double sinc = m == 0.0 ? 2.0 * fc : std::sin(2.0 * M_PI * fc * m) / (M_PI * m);
    double r = mid == 0.0 ? 0.0 : m / mid;
    double w = bessel_i0(beta * std::sqrt(std::fmax(0.0, 1.0 - r * r))) / i0_beta;
    h[n] = sinc * w;
    sum += h[n];
  }
  std::vector<float> out(taps);
  for (size_t n = 0; n < taps; n++)
    out[n] = static_cast<float>(h[n] / sum);
  return out;
}

/// Filters each channel and keeps one output frame in `factor`, computing only the kept ones. State carries
/// across process() calls, so the output does not depend on how the input is split into blocks.
class Decimator {
 public:
  Decimator(size_t channels, size_t factor, std::vector<float> taps)
      : channels_(channels), factor_(factor), taps_(std::move(taps)), history_(channels * taps_.size() * 2, 0.0f) {}

  size_t channels() const { return this->channels_; }
  size_t factor() const { return this->factor_; }

  /// Most output frames process() can write for `frames` input frames.
  size_t max_output_frames(size_t frames) const { return frames / this->factor_ + 1; }

  /// Reads `frames` interleaved input frames and writes the output frames to `out`; returns how many.
  size_t process(const int32_t *in, size_t frames, int32_t *out) {
    const size_t n = this->taps_.size();
    size_t written = 0;
    for (size_t f = 0; f < frames; f++) {
      // Each channel's history is stored twice (at pos and pos + n), so the last n samples are always
      // contiguous at [pos + 1, pos + n], oldest first.
      this->pos_ = this->pos_ + 1 == n ? 0 : this->pos_ + 1;
      for (size_t c = 0; c < this->channels_; c++) {
        float *h = &this->history_[c * n * 2];
        float x = static_cast<float>(in[f * this->channels_ + c]);
        h[this->pos_] = x;
        h[this->pos_ + n] = x;
      }
      if (++this->phase_ < this->factor_)
        continue;
      this->phase_ = 0;
      for (size_t c = 0; c < this->channels_; c++) {
        const float *x = &this->history_[c * n * 2 + this->pos_ + 1];
        float acc = 0.0f;
        // The taps are symmetric, so convolution needs no reversal.
        for (size_t k = 0; k < n; k++)
          acc += this->taps_[k] * x[k];
        out[written * this->channels_ + c] = clamp_i32_(acc);
      }
      written++;
    }
    return written;
  }

  void reset() {
    std::fill(this->history_.begin(), this->history_.end(), 0.0f);
    this->pos_ = 0;
    this->phase_ = 0;
  }

 protected:
  static int32_t clamp_i32_(float v) {
    if (v >= 2147483520.0f)  // largest float below 2^31
      return INT32_MAX;
    if (v <= -2147483648.0f)
      return INT32_MIN;
    return static_cast<int32_t>(std::lrintf(v));
  }

  size_t channels_;
  size_t factor_;
  std::vector<float> taps_;
  std::vector<float> history_;
  size_t pos_{0};
  size_t phase_{0};
};

}  // namespace esphome::decimating
