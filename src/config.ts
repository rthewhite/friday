import "dotenv/config";

export const settings = {
  apiKey: process.env.GEMINI_API_KEY ?? "",
  model: process.env.FRIDAY_MODEL ?? "gemini-3.8-live",
  host: process.env.FRIDAY_HOST ?? "0.0.0.0",
  port: Number(process.env.FRIDAY_PORT ?? 8080),
  voice: process.env.FRIDAY_VOICE ?? "Aoede",
  systemPrompt: `You are Friday, a concise and friendly voice assistant.
Keep spoken answers short. Use tools whenever they can answer the question
instead of guessing. Answer in the language the user speaks.`,
  // Audio formats mandated by the Live API
  inputRate: 16000,
  outputRate: 24000,
} as const;
