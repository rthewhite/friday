"""xvf3800: the reSpeaker XVF3800 over I2C (I2S firmware 1.0.9 only).

    xvf3800:
      id: xvf
      left: [6, 3]    # [category, source] on I2S left: processed auto-select beam (AEC, noise suppression)
      right: [7, 3]   # ASR auto-select beam
      agc: false
      on_mute:
        - lambda: id(mics_16k).set_mute_state(muted);

Checks the firmware version at boot and applies the settings the chip forgets on reset. The Mute button is
handled by the XVF3800 itself; on_mute fires when it (or xvf3800.mute / xvf3800.unmute) changes the state,
which is kept in flash. The LED ring is the `xvf3800` light platform (light.py).
"""

from esphome import automation
import esphome.codegen as cg
from esphome.components import i2c
import esphome.config_validation as cv
from esphome.const import CONF_ID, CONF_TRIGGER_ID

DEPENDENCIES = ["i2c"]
MULTI_CONF = False

CONF_XVF3800_ID = "xvf3800_id"
CONF_LEFT = "left"
CONF_RIGHT = "right"
CONF_AGC = "agc"
CONF_ON_MUTE = "on_mute"

xvf3800_ns = cg.esphome_ns.namespace("xvf3800")
XVF3800 = xvf3800_ns.class_("XVF3800", cg.Component, i2c.I2CDevice)
MuteTrigger = xvf3800_ns.class_("MuteTrigger", automation.Trigger.template(cg.bool_))
MuteAction = xvf3800_ns.class_("MuteAction", automation.Action, cg.Parented.template(XVF3800))
UnmuteAction = xvf3800_ns.class_("UnmuteAction", automation.Action, cg.Parented.template(XVF3800))

# AUDIO_MGR_OP categories 0-12, sources 0-5 (XMOS XVF3800 user guide).
ROUTE = cv.All(cv.ensure_list(cv.int_range(0, 12)), cv.Length(min=2, max=2), lambda v: _route(v))


def _route(value):
    if value[1] > 5:
        raise cv.Invalid("source must be 0-5")
    return value


CONFIG_SCHEMA = (
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(XVF3800),
            cv.Optional(CONF_LEFT, default=[6, 3]): ROUTE,
            cv.Optional(CONF_RIGHT, default=[7, 3]): ROUTE,
            cv.Optional(CONF_AGC, default=False): cv.boolean,
            cv.Optional(CONF_ON_MUTE): automation.validate_automation(
                {cv.GenerateID(CONF_TRIGGER_ID): cv.declare_id(MuteTrigger)}
            ),
        }
    )
    .extend(cv.COMPONENT_SCHEMA)
    .extend(i2c.i2c_device_schema(0x2C))
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    await i2c.register_i2c_device(var, config)
    cg.add(var.set_left(*config[CONF_LEFT]))
    cg.add(var.set_right(*config[CONF_RIGHT]))
    cg.add(var.set_agc(config[CONF_AGC]))
    for conf in config.get(CONF_ON_MUTE, []):
        trigger = cg.new_Pvariable(conf[CONF_TRIGGER_ID], var)
        await automation.build_automation(trigger, [(cg.bool_, "muted")], conf)


ACTION_SCHEMA = automation.maybe_simple_id({cv.GenerateID(): cv.use_id(XVF3800)})


async def _simple_action(config, action_id, template_arg, args):
    var = cg.new_Pvariable(action_id, template_arg)
    await cg.register_parented(var, config[CONF_ID])
    return var


automation.register_action("xvf3800.mute", MuteAction, ACTION_SCHEMA, synchronous=True)(_simple_action)
automation.register_action("xvf3800.unmute", UnmuteAction, ACTION_SCHEMA, synchronous=True)(_simple_action)
