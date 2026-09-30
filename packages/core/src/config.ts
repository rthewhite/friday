import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DEFAULT_PROMPT_CONTEXT_MAX_CHARS } from "@friday/sdk";

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
    /** Longest wait before retrying a rate-limited call unless the request sets `maxRetryWaitMs`. */
    llmMaxRetryWaitMs: env.FRIDAY_LLM_MAX_RETRY_WAIT_MS && Number.isFinite(Number(env.FRIDAY_LLM_MAX_RETRY_WAIT_MS)) && Number(env.FRIDAY_LLM_MAX_RETRY_WAIT_MS) >= 0 ? Number(env.FRIDAY_LLM_MAX_RETRY_WAIT_MS) : 60000,
  };
}

/** Portal chat. A function of the environment so the defaults are testable. */
export function chatSettings(env: Record<string, string | undefined>) {
  const timeout = Number(env.FRIDAY_CHAT_TOOL_TIMEOUT_MS);
  return {
    /** Model chat turns run on; falls back to the text model. */
    chatModel: env.FRIDAY_CHAT_MODEL || llmSettings(env).textModel,
    /** A chat tool call that has not settled after this long is answered with a timeout error. */
    chatToolTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
  };
}

/** Module prompt context. A function of the environment so the default is testable. */
export function promptSettings(env: Record<string, string | undefined>) {
  const max = Math.floor(Number(env.FRIDAY_PROMPT_CONTEXT_MAX_CHARS));
  return {
    /** Each module's prompt context is cut to this many characters. */
    promptContextMaxChars: Number.isFinite(max) && max > 0 ? max : DEFAULT_PROMPT_CONTEXT_MAX_CHARS,
  };
}

/** Friday's instructions: a base shared by every channel, plus one part per channel. */
export const prompts = {
  base: `You are Friday, a friendly personal assistant. Use tools whenever they can
answer the question instead of guessing. Answer in the language the user speaks.`,
  voice: `You are speaking with the user. Be concise and keep spoken answers short.

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
  other pending tool is expected to report back.
- Never call end_conversation in a turn whose reply ends with a question
  or invites the user to talk ("What would you like to share?", "Anything
  else?"). Ask, then wait for the answer.
- When the user invites you to chat, tell them something, or offers to
  share information, that starts an open conversation. It is not a
  finished request, so keep listening.`,
  chat: `The user is typing to you in a chat in Friday's portal. Be concise but
complete: answer fully instead of keeping it short for speech. You may use
Markdown (lists, tables, bold, links, code blocks) where it helps readability.`,
} as const;

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
  /** Delete conversations whose last activity is older than this many days (nightly). 0 keeps them forever. */
  conversationRetentionDays: Number(process.env.FRIDAY_CONVERSATION_RETENTION_DAYS ?? 90),
  /** A conversation without activity for this many minutes goes quiet. */
  conversationQuietMinutes: Number(process.env.FRIDAY_CONVERSATION_QUIET_MINUTES ?? 30),
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
  /** Recorded runs kept per background job. */
  jobHistory: Number(process.env.FRIDAY_JOB_HISTORY ?? 50),
  /** Delay before the one catch-up run of a job whose due time passed while Friday was down. */
  jobCatchupDelayMs: Number(process.env.FRIDAY_JOB_CATCHUP_DELAY_MS ?? 30000),
  /** textModel, textModelFast, llmConcurrency, llmTimeoutMs. */
  ...llmSettings(process.env),
  /** chatModel, chatToolTimeoutMs. */
  ...chatSettings(process.env),
  /** promptContextMaxChars. */
  ...promptSettings(process.env),
  /** The Live session's instruction: the shared base plus the voice part. */
  systemPrompt: `${prompts.base}\n\n${prompts.voice}`,
  /** A chat turn's instruction: the shared base plus the chat part. */
  chatPrompt: `${prompts.base}\n\n${prompts.chat}`,
  // Audio formats mandated by the Live API
  inputRate: 16000,
  outputRate: 24000,
} as const;
