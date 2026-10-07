"""light: platform xvf3800, the 12 WS2812 LEDs the XVF3800 drives (LED_RING_COLOR over I2C).

    light:
      - platform: xvf3800
        id: leds_internal
        name: LED ring (raw)
        internal: true

LED 0 is at the top centre of the board. Writes go out only when the colours changed, at most every 50 ms.
"""

import esphome.codegen as cg
from esphome.components import light
import esphome.config_validation as cv
from esphome.const import CONF_OUTPUT_ID

from . import CONF_XVF3800_ID, XVF3800, xvf3800_ns

DEPENDENCIES = ["xvf3800"]

XVF3800Light = xvf3800_ns.class_("XVF3800Light", light.AddressableLight)

CONFIG_SCHEMA = light.ADDRESSABLE_LIGHT_SCHEMA.extend(
    {
        cv.GenerateID(CONF_OUTPUT_ID): cv.declare_id(XVF3800Light),
        cv.GenerateID(CONF_XVF3800_ID): cv.use_id(XVF3800),
    }
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_OUTPUT_ID])
    await light.register_light(var, config)
    await cg.register_component(var, config)
    hub = await cg.get_variable(config[CONF_XVF3800_ID])
    cg.add(var.set_hub(hub))
    cg.add(hub.set_ring_used(True))
