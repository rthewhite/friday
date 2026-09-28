import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** packages/core/{src,dist}/config.ts -> packages/portal/dist. Override with FRIDAY_WEB_DIR (the image sets it). */
const defaultWebDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "portal", "dist");

/** Text generation for modules (`ctx.llm`). A function of the environment so the defaults are testable. */
export function llmSettings(env: Record<string, string | undefined>) {
  const textModel = env.FRIDAY_TEXT_MODEL || "gemini-flash-latest";
  return {
    /** Model for the `standard` tier. The default alias follows Google's current Flash model. */
    textModel,
    /** Model for the `fast` tier; falls back to the standard model. */
    textModelFast: env.FRIDAY_TEXT_MODEL_FAST || textModel,
    /** Model calls in flight at once, across all modules; further calls queue in order. */
    llmConcurrency: Math.max(1, Math.floor(Number(env.FRIDAY_LLM_CONCURRENCY) || 2)),
    /** Per-attempt limit for a model call unless the request sets `timeoutMs`. */
    llmTimeoutMs: Number(env.FRIDAY_LLM_TIMEOUT_MS) || 120000,
  };
}

export const settings = {
  apiKey: process.env.GEMINI_API_KEY ?? "",
  model: process.env.FRIDAY_MODEL ?? "gemini-3.8-live",
  host: process.env.FRIDAY_HOST ?? "0.0.0.0",
  port: Number(process.env.FRIDAY_PORT ?? 8080),
  /** Directory the built portal is served from (SPA with index.html fallback). */
  webDir: process.env.FRIDAY_WEB_DIR ?? defaultWebDir,
  voice: process.env.FRIDAY_VOICE ?? "Aoede",
  /** Close the session when the user stays silent this long after Friday finishes a turn. 0 disables. */
  idleTimeoutMs: Number(process.env.FRIDAY_IDLE_TIMEOUT_MS ?? 8000),
  /** WebSocket ping interval; connections that miss a pong are terminated. 0 disables. */
  wsPingMs: Number(process.env.FRIDAY_WS_PING_MS ?? 20000),
  /** Directory for friday.db (SQLite). The image sets /data; dev defaults to ./data. */
  dataDir: process.env.FRIDAY_DATA_DIR ?? "./data",
  /** 32-byte base64 key that encrypts stored configuration values. Unset disables the config store. */
  masterKey: process.env.FRIDAY_MASTER_KEY,
  /** `<id>=<key>,...` pairs that let remote modules register on /ws/modules (fallback to portal-issued keys). */
  moduleKeys: process.env.FRIDAY_MODULE_KEYS,
  /** Give a remote module this long to answer a tool call before the model gets `{ error: "timeout" }`. */
  remoteCallTimeoutMs: Number(process.env.FRIDAY_REMOTE_CALL_TIMEOUT_MS ?? 10000),
  /**
   * Gemini's start-of-speech detection. LOW ignores faint sounds such as residual echo of
   * Friday's own voice on speaker devices; HIGH is Gemini's default and interrupts more eagerly.
   */
  vadStartSensitivity: (process.env.FRIDAY_VAD_START_SENSITIVITY ?? "LOW").toUpperCase() === "HIGH" ? "HIGH" : "LOW",
  /** Speech must last this long before Gemini treats it as the user talking (and interrupts). */
  vadPrefixPaddingMs: Number(process.env.FRIDAY_VAD_PREFIX_MS ?? 200),
  /** Print what Gemini hears the user say to the server log. Useful for echo debugging; off by default. */
  logTranscripts: process.env.FRIDAY_LOG_TRANSCRIPTS === "1",
  /** IANA zone cron job schedules are evaluated in (also the builtin module's default zone). */
  timezone: process.env.FRIDAY_TIMEZONE || "Europe/Amsterdam",
  /** Recorded runs kept per background job. */
  jobHistory: Number(process.env.FRIDAY_JOB_HISTORY ?? 50),
  /** Delay before the one catch-up run of a job whose due time passed while Friday was down. */
  jobCatchupDelayMs: Number(process.env.FRIDAY_JOB_CATCHUP_DELAY_MS ?? 30000),
  /** textModel, textModelFast, llmConcurrency, llmTimeoutMs. */
  ...llmSettings(process.env),
  systemPrompt: `You are Friday, a concise and friendly voice assistant.
Keep spoken answers short. Use tools whenever they can answer the question
instead of guessing. Answer in the language the user speaks.

Ending the conversation: the microphone stays open until you end the
conversation, so decide deliberately when to end it.
- After you have fully handled a request (e.g. turned on lights, started
  playback, answered a question) and you have no follow-up question for the
  user, give a brief confirmation and call end_conversation in the same turn.
- If the user signals they are done ("goodbye", "thanks", "that's all",
  "stop", "end conversation", or similar in any language), say a short
  goodbye and call end_conversation.
- Do NOT end the conversation while you still need information from the
  user, while you are asking a clarifying question, or while a timer or
  other pending tool is expected to report back.`,
  // Audio formats mandated by the Live API
  inputRate: 16000,
  outputRate: 24000,
} as const;
