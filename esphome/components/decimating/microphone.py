"""microphone: platform decimating

    microphone:
      - platform: decimating
        id: mics_16k
        microphone: i2s_mics   # 48 kHz, 32 bit, stereo
        channels: 2

The output is 16 kHz, 32 bit, with the source's channel layout. Consumers take it through a microphone_source
(channel selection, bit depth, gain) like any other microphone.
"""

import esphome.codegen as cg
from esphome.components import audio, microphone
import esphome.config_validation as cv
from esphome.const import CONF_CHANNELS, CONF_ID, CONF_MICROPHONE
from esphome.types import ConfigType

DEPENDENCIES = ["microphone"]

SOURCE_RATE = 48000
OUTPUT_RATE = 16000
BITS = 32

decimating_ns = cg.esphome_ns.namespace("decimating")
DecimatingMicrophone = decimating_ns.class_("DecimatingMicrophone", microphone.Microphone, cg.Component)


def _set_stream_limits(config: ConfigType) -> ConfigType:
    audio.set_stream_limits(
        min_bits_per_sample=BITS,
        max_bits_per_sample=BITS,
        min_channels=config[CONF_CHANNELS],
        max_channels=config[CONF_CHANNELS],
        min_sample_rate=OUTPUT_RATE,
        max_sample_rate=OUTPUT_RATE,
    )(config)
    return config


CONFIG_SCHEMA = cv.All(
    microphone.MICROPHONE_SCHEMA.extend(
        {
            cv.GenerateID(): cv.declare_id(DecimatingMicrophone),
            cv.Required(CONF_MICROPHONE): cv.use_id(microphone.Microphone),
            cv.Optional(CONF_CHANNELS, default=2): cv.int_range(1, 2),
        }
    ).extend(cv.COMPONENT_SCHEMA),
    _set_stream_limits,
)


def _final_validate(config: ConfigType) -> ConfigType:
    # The source must deliver exactly what the filter is designed for.
    audio.final_validate_audio_schema(
        "decimating",
        audio_device=CONF_MICROPHONE,
        bits_per_sample=BITS,
        channels=config[CONF_CHANNELS],
        sample_rate=SOURCE_RATE,
        audio_device_issue=True,
    )(config)
    return config


FINAL_VALIDATE_SCHEMA = _final_validate


async def to_code(config: ConfigType) -> None:
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    await microphone.register_microphone(var, config)
    source = await cg.get_variable(config[CONF_MICROPHONE])
    cg.add(var.set_source(source))
    cg.add(var.set_channels(config[CONF_CHANNELS]))
