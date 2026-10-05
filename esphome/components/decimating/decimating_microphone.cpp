#include "decimating_microphone.h"

#include "esphome/core/log.h"

namespace esphome::decimating {

static const char *const TAG = "decimating";

void DecimatingMicrophone::setup() {
  this->audio_stream_info_ = audio::AudioStreamInfo(32, this->channels_, OUTPUT_RATE);
  this->decimator_ = std::make_unique<Decimator>(this->channels_, SOURCE_RATE / OUTPUT_RATE,
                                                 design_lowpass(TAPS, CUTOFF_HZ, SOURCE_RATE, BETA));
  this->source_->add_data_callback([this](const std::vector<uint8_t> &data) { this->on_source_data_(data); });
}

void DecimatingMicrophone::start() {
  if (this->listeners_.fetch_add(1) == 0)
    this->reset_pending_ = true;
  if (this->state_ == microphone::STATE_STOPPED)
    this->state_ = microphone::STATE_STARTING;
  this->source_->start();
}

void DecimatingMicrophone::stop() {
  int n = this->listeners_.load();
  while (n > 0 && !this->listeners_.compare_exchange_weak(n, n - 1)) {
  }
  if (n <= 0)
    return;  // not started through us
  if (n == 1 && this->state_ != microphone::STATE_STOPPED)
    this->state_ = microphone::STATE_STOPPING;
  this->source_->stop();
}

void DecimatingMicrophone::loop() {
  // Follow the source while anyone listens through us; stop once the last listener has gone.
  if (this->listeners_.load() > 0) {
    if (this->source_->is_running())
      this->state_ = microphone::STATE_RUNNING;
  } else if (this->state_ != microphone::STATE_STOPPED) {
    this->state_ = microphone::STATE_STOPPED;
  }
}

void DecimatingMicrophone::on_source_data_(const std::vector<uint8_t> &data) {
  if (this->listeners_.load() <= 0)
    return;
  if (this->reset_pending_.exchange(false))
    this->decimator_->reset();

  const size_t frame_bytes = sizeof(int32_t) * this->channels_;
  const size_t frames = data.size() / frame_bytes;
  this->out_.resize(this->decimator_->max_output_frames(frames) * frame_bytes);
  size_t written = this->decimator_->process(reinterpret_cast<const int32_t *>(data.data()), frames,
                                             reinterpret_cast<int32_t *>(this->out_.data()));
  if (written == 0)
    return;
  this->out_.resize(written * frame_bytes);
  this->data_callbacks_.call(this->out_);
}

void DecimatingMicrophone::dump_config() {
  ESP_LOGCONFIG(TAG,
                "Decimating microphone:\n"
                "  %u kHz -> %u kHz, %u channel(s), 32 bit\n"
                "  FIR: %u taps, cutoff %.0f Hz, Kaiser beta %.2f",
                (unsigned) (SOURCE_RATE / 1000), (unsigned) (OUTPUT_RATE / 1000), this->channels_, (unsigned) TAPS,
                CUTOFF_HZ, BETA);
}

}  // namespace esphome::decimating
