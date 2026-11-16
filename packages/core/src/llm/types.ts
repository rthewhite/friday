/**
 * Core's provider-neutral text-model types (llm-adapters). Chat, agents and `ctx.llm` speak only these;
 * an adapter per provider (Gemini, OpenAI-compatible) maps them to its own wire format. Shaped like
 * OpenAI's chat messages, but owned by Friday: no provider SDK types appear outside the adapters.
 */
import { LlmError, type FunctionDeclaration, type JsonSchema, type LlmUsage } from "@friday/sdk";

/** One tool call: `id` is unique within a request and pairs the call with its `tool` message. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Data only the adapter that produced it reads (Gemini: the turn's parts, thought signatures included). */
export interface ProviderData {
  adapter: "gemini" | "openai";
  value: unknown;
}

export interface UserMessage {
  role: "user";
  text: string;
}

export interface AssistantMessage {
  role: "assistant";
  text?: string;
  toolCalls?: ToolCall[];
  providerData?: ProviderData;
}

/** The result of one earlier tool call of the same request. */
export interface ToolMessage {
  role: "tool";
  callId: string;
  name: string;
  result: Record<string, unknown>;
}

export type ChatMessage = UserMessage | AssistantMessage | ToolMessage;

export interface ChatRequest {
  /** Resolved model name. */
  model: string;
  system?: string;
  messages: ChatMessage[];
  /** Tools the model may call, in the SDK's own declaration form; none means no tools. */
  tools?: FunctionDeclaration[];
  /** Ask for JSON output conforming to this schema. */
  schema?: JsonSchema;
  temperature?: number;
  maxOutputTokens?: number;
  /** Ask for thought summaries (streamed as `thought` chunks). */
  thoughts?: boolean;
}

/** One streamed piece. A call is yielded only once all of its arguments have arrived. */
export type StreamChunk = { kind: "text" | "thought"; text: string } | { kind: "call"; call: ToolCall };

/**
 * Why the model stopped. A provider block is not a finish reason: it rejects with `LlmError("blocked")`.
 * - `stop`: finished, with or without tool calls;
 * - `length`: cut off at the output limit;
 * - `malformed_call`: a tool call that could not be read;
 * - `other`: anything else (`providerReason` holds the provider's own reason).
 */
export type FinishReason = "stop" | "length" | "malformed_call" | "other";

/** How a call ended: the stream's return value, and `generate`'s result. */
export interface ModelEnd {
  finish: FinishReason;
  providerReason?: string;
  /** The model version that answered, as reported by the provider (else the requested model). */
  model: string;
  usage: Required<LlmUsage>;
  /** The model's turn, to send back as it is within the same chat turn or agent run. */
  message: AssistantMessage;
}

export type ModelStream = AsyncGenerator<StreamChunk, ModelEnd>;

/** A text model provider. Adapters throw `ProviderError` for provider failures and `LlmError` for blocks and our own errors. */
export interface ChatModel {
  /** One-shot call; the answer is `message.text`. */
  generate(req: ChatRequest, opts?: { signal?: AbortSignal }): Promise<ModelEnd>;
  /** Streamed call with tools. */
  stream(req: ChatRequest, opts?: { signal?: AbortSignal }): ModelStream;
}

/**
 * The provider refused the prompt or stopped the response for safety or policy: an `LlmError` of kind
 * `blocked` (never retried) that also carries the answering model and usage, so the call's log line keeps
 * its token counts.
 */
export class BlockedError extends LlmError {
  constructor(
    message: string,
    reason: string,
    readonly model: string,
    readonly usage: Required<LlmUsage>,
  ) {
    super("blocked", message, { reason });
  }
}

/**
 * A provider failure in neutral terms, which `LlmService` turns into retries and an `LlmError`:
 * - `rate_limited`: `waitMs` when the provider states a wait, `quota` (and `daily`) when it names one;
 * - `transient`: HTTP 408 or 5xx, or the server could not be reached (`reason` `network`);
 * - `invalid_request`: the provider rejected the request (HTTP 400, 404, 422);
 * - `failed`: anything else; not retried.
 */
export class ProviderError extends Error {
  readonly kind: "rate_limited" | "transient" | "invalid_request" | "failed";
  /** For the log: the HTTP status (`429`, `503`) or `network`. */
  readonly reason: string;
  readonly waitMs?: number;
  readonly quota?: string;
  readonly daily?: boolean;

  constructor(
    kind: ProviderError["kind"],
    reason: string,
    message: string,
    opts: { waitMs?: number; quota?: string; daily?: boolean; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ProviderError";
    this.kind = kind;
    this.reason = reason;
    if (opts.waitMs !== undefined) this.waitMs = opts.waitMs;
    if (opts.quota !== undefined) this.quota = opts.quota;
    if (opts.daily !== undefined) this.daily = opts.daily;
  }
}
