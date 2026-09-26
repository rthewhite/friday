/** Small native tools that ship with Friday: current time, countdown timers, end_conversation. */
import { defineModule, Type } from "@friday/sdk";

export default defineModule({
  manifest: {
    id: "builtin",
    label: "Builtin",
    description: "Current time, timers and ending the conversation.",
    config: [{ key: "FRIDAY_TIMEZONE", description: "Default IANA zone for get_current_time (default Europe/Amsterdam)" }],
  },
  init(ctx) {
    ctx.defineTool<{ timezone?: string }>({
      name: "get_current_time",
      description: "Get the current date and time, optionally in a specific IANA timezone.",
      parameters: {
        type: Type.OBJECT,
        properties: { timezone: { type: Type.STRING, description: "IANA zone, e.g. Europe/Amsterdam" } },
      },
      handler: ({ timezone }) => {
        const zone = timezone || ctx.config.get("FRIDAY_TIMEZONE") || "Europe/Amsterdam";
        const now = new Date();
        return {
          iso: now.toISOString(),
          human: now.toLocaleString("en-GB", { timeZone: zone, dateStyle: "full", timeStyle: "short" }),
          timezone: zone,
        };
      },
    });

    ctx.defineTool<{ seconds: number; label?: string }>({
      name: "set_timer",
      description: "Start a countdown timer. Reports back when it finishes.",
      parameters: {
        type: Type.OBJECT,
        properties: { seconds: { type: Type.INTEGER }, label: { type: Type.STRING } },
        required: ["seconds"],
      },
      scheduling: "WHEN_IDLE",
      handler: async ({ seconds, label = "timer" }) => {
        await new Promise((r) => setTimeout(r, seconds * 1000));
        return { done: true, label, message: `${label} finished after ${seconds} seconds` };
      },
    });

    ctx.defineTool<{ reason?: string }>({
      name: "end_conversation",
      description:
        "End the voice conversation and stop listening. Call this in the same turn as your final spoken words " +
        "once a request is fully handled and you have no follow-up question, or when the user says goodbye.",
      parameters: {
        type: Type.OBJECT,
        properties: { reason: { type: Type.STRING, description: "Short reason, e.g. 'request done' or 'user said goodbye'" } },
      },
      scheduling: "SILENT",
      // `endConversation` is the registry's reserved key: stripped from the result, it tells the session to close.
      handler: ({ reason = "done" }) => ({ ending: true, reason, endConversation: reason }),
    });
  },
});
