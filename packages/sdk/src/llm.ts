/**
 * Text generation contract (`ctx.llm`): request and result types, the typed error, and the
 * request checks and output validation that core and the test host both apply.
 */
import { Ajv, type ValidateFunction } from "ajv";

export type LlmRole = "user" | "model";

export interface LlmMessage {
  role: LlmRole;
  text: string;
}

/** Model tier; core maps it to FRIDAY_TEXT_MODEL (`standard`) or FRIDAY_TEXT_MODEL_FAST (`fast`). */
export type LlmTier = "standard" | "fast";

/** A plain JSON Schema object. Gemini supports a subset; see the SDK README. */
export type JsonSchema = Record<string, unknown>;

export interface LlmRequest {
  system?: string;
  /** Exactly one of `prompt` and `messages`. */
  prompt?: string;
  messages?: LlmMessage[];
  /** When given, the answer is JSON, parsed and validated against this schema, and returned as `json`. */
  schema?: JsonSchema;
  model?: LlmTier;
  temperature?: number;
  maxOutputTokens?: number;
  /** Aborting rejects the call with `cancelled`, also while it waits for a slot. */
  signal?: AbortSignal;
  /** Per-attempt limit; defaults to FRIDAY_LLM_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens spent on thinking, when the model reports them. */
  thoughtTokens?: number;
}

export interface LlmResult<T = unknown> {
  text: string;
  /** Parsed, schema-validated output; present when the request had a `schema`. */
  json?: T;
  /** The model that answered. */
  model: string;
  usage: LlmUsage;
}

export interface ModuleLlm {
  generate<T = unknown>(request: LlmRequest): Promise<LlmResult<T>>;
}

/**
 * - `unavailable`: unreachable, rate-limited, provider error, no key, or timed out (worth retrying later)
 * - `invalid_output`: the answer did not parse, match the schema, or was truncated (`raw` carries it)
 * - `blocked`: the provider refused the prompt or stopped for safety (`reason` carries why)
 * - `invalid_request`: the request itself is wrong (input shape, schema, rejected by the provider)
 * - `cancelled`: the caller's signal was aborted
 */
export type LlmErrorKind = "unavailable" | "invalid_output" | "blocked" | "invalid_request" | "cancelled";

/** Raw output carried by `invalid_output` is capped at this many characters. */
export const RAW_OUTPUT_LIMIT = 2000;

export class LlmError extends Error {
  override readonly name = "LlmError";
  readonly kind: LlmErrorKind;
  /** Provider's reason for `blocked`, e.g. `SAFETY`. */
  readonly reason?: string;
  /** The model's raw text for `invalid_output`, capped at RAW_OUTPUT_LIMIT characters. */
  readonly raw?: string;

  constructor(kind: LlmErrorKind, message: string, opts: { reason?: string; raw?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.kind = kind;
    if (opts.reason !== undefined) this.reason = opts.reason;
    if (opts.raw !== undefined) this.raw = opts.raw.slice(0, RAW_OUTPUT_LIMIT);
  }
}

// strict: false lets Gemini-specific keywords (e.g. propertyOrdering) through; formats are not checked.
const ajv = new Ajv({ strict: false, validateFormats: false });
const compiled = new WeakMap<object, ValidateFunction>();

function validator(schema: JsonSchema): ValidateFunction {
  let v = compiled.get(schema);
  if (!v) {
    try {
      v = ajv.compile(schema);
    } catch (e) {
      throw new LlmError("invalid_request", `schema is not a valid JSON Schema: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    compiled.set(schema, v);
  }
  return v;
}

/** Throws `invalid_request` unless the request has exactly one of `prompt`/`messages` and a schema that compiles. */
export function checkRequest(req: LlmRequest): void {
  const bad = (msg: string) => new LlmError("invalid_request", msg);
  if (!req || typeof req !== "object") throw bad("request must be an object");
  const hasPrompt = req.prompt !== undefined;
  const hasMessages = req.messages !== undefined;
  if (hasPrompt === hasMessages) throw bad("request needs exactly one of prompt or messages");
  if (hasPrompt && typeof req.prompt !== "string") throw bad("prompt must be a string");
  if (hasMessages) {
    if (!Array.isArray(req.messages) || req.messages.length === 0) throw bad("messages must be a non-empty array");
    for (const m of req.messages) {
      if (!m || (m.role !== "user" && m.role !== "model") || typeof m.text !== "string") throw bad('each message needs role "user" or "model" and a text string');
    }
  }
  if (req.model !== undefined && req.model !== "standard" && req.model !== "fast") throw bad('model must be "standard" or "fast"');
  if (req.schema !== undefined) {
    if (!req.schema || typeof req.schema !== "object" || Array.isArray(req.schema)) throw bad("schema must be a JSON Schema object");
    validator(req.schema);
  }
}

/**
 * Parses and validates schema output. Throws `invalid_output` (with the raw text) when the model
 * stopped at the output limit, the text is not JSON, or it does not match the schema.
 */
export function parseOutput<T = unknown>(schema: JsonSchema, text: string, finishReason?: string): T {
  if (finishReason === "MAX_TOKENS") throw new LlmError("invalid_output", "output was truncated at the output token limit", { raw: text });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LlmError("invalid_output", "output is not valid JSON", { raw: text });
  }
  const v = validator(schema);
  if (!v(value)) throw new LlmError("invalid_output", `output does not match the schema: ${ajv.errorsText(v.errors)}`, { raw: text });
  return value as T;
}
