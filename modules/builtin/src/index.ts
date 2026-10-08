/** Small native tools that ship with Friday: current time and end_conversation. Timers are core's alerts. */
import { DEFAULT_TIME_ZONE, defineModule, householdTimeZone, Type } from "@friday/sdk";

export default defineModule({
  manifest: {
    id: "builtin",
    label: "Builtin",
    description: "Current time and ending the conversation.",
    config: [{ key: "FRIDAY_TIMEZONE", description: `Default IANA zone for get_current_time (default ${DEFAULT_TIME_ZONE})` }],
  },
  init(ctx) {
    const householdZone = householdTimeZone(ctx.config, (m) => ctx.log.warn(m));

    ctx.defineTool<{ timezone?: string }>({
      name: "get_current_time",
      description: "Get the current date and time, optionally in a specific IANA timezone.",
      parameters: {
        type: Type.OBJECT,
        properties: { timezone: { type: Type.STRING, description: "IANA zone, e.g. Europe/Amsterdam" } },
      },
      handler: ({ timezone }) => {
        // An explicit zone the model got wrong fails (naming it) rather than quietly answering elsewhere;
        // a blank one counts as not given.
        const zone = timezone?.trim() || householdZone();
        const now = new Date();
        return {
          iso: now.toISOString(),
          human: now.toLocaleString("en-GB", { timeZone: zone, dateStyle: "full", timeStyle: "short" }),
          timezone: zone,
        };
      },
    });

    ctx.defineTool<{ reason?: string }>({
      name: "end_conversation",
      description:
        "End the voice conversation and stop listening. Call this in the same turn as your final spoken words " +
        "once a request is fully handled and you have no follow-up question, or when the user says goodbye. " +
        "Never call it when your final words are a question or invite the user to talk; wait for the answer instead.",
      parameters: {
        type: Type.OBJECT,
        properties: { reason: { type: Type.STRING, description: "Short reason, e.g. 'request done' or 'user said goodbye'" } },
      },
      scheduling: "SILENT",
      channels: ["voice"],
      // `endConversation` is the registry's reserved key: stripped from the result, it tells the session to close.
      handler: ({ reason = "done" }) => ({ ending: true, reason, endConversation: reason }),
    });
  },
});
