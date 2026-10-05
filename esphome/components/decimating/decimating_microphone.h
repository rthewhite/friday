#pragma once

#include "esphome/core/component.h"
#include "esphome/components/microphone/microphone.h"

#include "decimator.h"

#include <atomic>
#include <memory>
#include <vector>

namespace esphome::decimating {

/**
 * A 16 kHz microphone on top of a 48 kHz, 32-bit source microphone (decimator.h does the filtering).
 *
 * start()/stop() are passed straight to the source, which counts its listeners. The filter runs in the
 * source's data callback (its task) only while this microphone has listeners, and is reset when the first
 * listener starts so a new capture never begins with stale history.
 */
class DecimatingMicrophone : public microphone::Microphone, public Component {
 public:
  // 175 taps, cutoff 7.5 kHz, Kaiser beta 5.65: < 0.01 dB ripple to 7 kHz, > 60 dB from 8 kHz (design decision 3).
  static constexpr size_t TAPS = 175;
  static constexpr float CUTOFF_HZ = 7500.0f;
  static constexpr float BETA = 5.65f;
  static constexpr uint32_t SOURCE_RATE = 48000;
  static constexpr uint32_t OUTPUT_RATE = 16000;

  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::DATA; }

  void set_source(microphone::Microphone *source) { this->source_ = source; }
  void set_channels(uint8_t channels) { this->channels_ = channels; }

  void start() override;
  void stop() override;

 protected:
  void on_source_data_(const std::vector<uint8_t> &data);

  microphone::Microphone *source_{nullptr};
  uint8_t channels_{2};
  std::unique_ptr<Decimator> decimator_;
  std::vector<uint8_t> out_;  // only touched in the source's task
  std::atomic<int> listeners_{0};
  std::atomic<bool> reset_pending_{true};
};

}  // namespace esphome::decimating
