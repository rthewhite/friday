import { Type } from "@google/genai";
import { defineTool } from "./index.js";

defineTool<{ timezone?: string }>({
  name: "get_current_time",
  description: "Get the current date and time, optionally in a specific IANA timezone.",
  parameters: {
    type: Type.OBJECT,
    properties: { timezone: { type: Type.STRING, description: "IANA zone, e.g. Europe/Amsterdam" } },
  },
  handler: ({ timezone = "Europe/Amsterdam" }) => {
    const now = new Date();
    return {
      iso: now.toISOString(),
      human: now.toLocaleString("en-GB", { timeZone: timezone, dateStyle: "full", timeStyle: "short" }),
      timezone,
    };
  },
});

defineTool<{ seconds: number; label?: string }>({
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
