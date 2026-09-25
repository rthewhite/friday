"""friday_client: press-to-talk client for the Friday voice assistant.

Streams 16 kHz mono PCM from a microphone source to Friday's /ws/audio
WebSocket and plays the 24 kHz reply through a speaker. Session state is
exposed through an on_state trigger; start/stop/toggle/error are actions.
"""

import esphome.codegen as cg
import esphome.config_validation as cv
from esphome import automation
from esphome.components import microphone, speaker
from esphome.components.esp32 import add_idf_component, include_builtin_idf_component
from esphome.const import CONF_ID, CONF_MICROPHONE, CONF_SPEAKER, CONF_TRIGGER_ID, CONF_URL

DEPENDENCIES = ["esp32", "microphone", "speaker"]
AUTO_LOAD = ["json"]

CONF_DEVICE_ID = "device_id"
CONF_ON_STATE = "on_state"
CONF_CONNECT_TIMEOUT = "connect_timeout"
CONF_DRAIN_TIMEOUT = "drain_timeout"
CONF_ERROR_HOLD = "error_hold"
CONF_SEND_CHUNK = "send_chunk"

friday_ns = cg.esphome_ns.namespace("friday_client")
FridayClient = friday_ns.class_("FridayClient", cg.Component)
StateTrigger = friday_ns.class_("StateTrigger", automation.Trigger.template(cg.std_string))
StartAction = friday_ns.class_("StartAction", automation.Action, cg.Parented.template(FridayClient))
StopAction = friday_ns.class_("StopAction", automation.Action, cg.Parented.template(FridayClient))
ToggleAction = friday_ns.class_("ToggleAction", automation.Action, cg.Parented.template(FridayClient))
ErrorAction = friday_ns.class_("ErrorAction", automation.Action, cg.Parented.template(FridayClient))


def _ws_url(value):
    value = cv.string_strict(value)
    if not value.startswith("ws://"):
        raise cv.Invalid("url must start with ws:// (TLS is not supported yet)")
    return value


CONFIG_SCHEMA = cv.All(
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(FridayClient),
            cv.Required(CONF_URL): _ws_url,
            cv.Optional(CONF_DEVICE_ID, default=""): cv.string,
            cv.Required(CONF_MICROPHONE): microphone.microphone_source_schema(
                min_bits_per_sample=16, max_bits_per_sample=16, min_channels=1, max_channels=1
            ),
            cv.Required(CONF_SPEAKER): cv.use_id(speaker.Speaker),
            cv.Optional(CONF_CONNECT_TIMEOUT, default="10s"): cv.positive_time_period_milliseconds,
            cv.Optional(CONF_DRAIN_TIMEOUT, default="5s"): cv.positive_time_period_milliseconds,
            cv.Optional(CONF_ERROR_HOLD, default="2s"): cv.positive_time_period_milliseconds,
            cv.Optional(CONF_SEND_CHUNK, default="100ms"): cv.All(
                cv.positive_time_period_milliseconds,
                cv.Range(min=cv.TimePeriod(milliseconds=20), max=cv.TimePeriod(milliseconds=1000)),
            ),
            cv.Optional(CONF_ON_STATE): automation.validate_automation(
                {cv.GenerateID(CONF_TRIGGER_ID): cv.declare_id(StateTrigger)}
            ),
        }
    ).extend(cv.COMPONENT_SCHEMA),
    cv.only_with_framework(cv.Framework.ESP_IDF),
)

FINAL_VALIDATE_SCHEMA = cv.Schema(
    {
        cv.Required(CONF_MICROPHONE): microphone.final_validate_microphone_source_schema(
            "friday_client", sample_rate=16000
        ),
    },
    extra=cv.ALLOW_EXTRA,
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)

    mic_source = await microphone.microphone_source_to_code(config[CONF_MICROPHONE])
    cg.add(var.set_microphone_source(mic_source))
    mic = await cg.get_variable(config[CONF_MICROPHONE][CONF_MICROPHONE])
    cg.add(var.set_microphone(mic))
    spk = await cg.get_variable(config[CONF_SPEAKER])
    cg.add(var.set_speaker(spk))

    cg.add(var.set_url(config[CONF_URL]))
    cg.add(var.set_device_id(config[CONF_DEVICE_ID]))
    cg.add(var.set_connect_timeout(config[CONF_CONNECT_TIMEOUT]))
    cg.add(var.set_drain_timeout(config[CONF_DRAIN_TIMEOUT]))
    cg.add(var.set_error_hold(config[CONF_ERROR_HOLD]))
    cg.add(var.set_send_chunk_ms(config[CONF_SEND_CHUNK]))

    for conf in config.get(CONF_ON_STATE, []):
        trigger = cg.new_Pvariable(conf[CONF_TRIGGER_ID], var)
        await automation.build_automation(trigger, [(cg.std_string, "state")], conf)

    # WebSocket client from the component registry; it needs the transport
    # layers ESPHome excludes from the IDF build by default.
    add_idf_component(name="espressif/esp_websocket_client", ref="1.8.0")
    include_builtin_idf_component("esp-tls")
    include_builtin_idf_component("tcp_transport")


ACTION_SCHEMA = cv.maybe_simple_value({cv.GenerateID(): cv.use_id(FridayClient)}, key=CONF_ID)


async def _simple_action(config, action_id, template_arg, args):
    var = cg.new_Pvariable(action_id, template_arg)
    await cg.register_parented(var, config[CONF_ID])
    return var


automation.register_action("friday_client.start", StartAction, ACTION_SCHEMA, synchronous=True)(_simple_action)
automation.register_action("friday_client.stop", StopAction, ACTION_SCHEMA, synchronous=True)(_simple_action)
automation.register_action("friday_client.toggle", ToggleAction, ACTION_SCHEMA, synchronous=True)(_simple_action)
automation.register_action("friday_client.error", ErrorAction, ACTION_SCHEMA, synchronous=True)(_simple_action)
