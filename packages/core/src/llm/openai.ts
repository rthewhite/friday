/**
 * The OpenAI-compatible adapter (llm-adapters): core's provider-neutral requests as chat completions
 * (`POST <baseUrl>/chat/completions`), for Ollama, vLLM, llama.cpp and similar servers, and OpenAI itself.
 * Our own client over `fetch` (injectable, like the CalDAV and Spotify clients), without the `openai`
 * package: its retries would stack with LlmService's, and its types would leak past the adapter.
 *
 * Built and tested here; nothing selects it yet (that is `llm-providers`).
 */
import { LlmError, type FunctionDeclaration, type Schema } from "@friday/sdk";
import { BlockedError, ProviderError, type AssistantMessage, type ChatMessage, type ChatModel, type ChatRequest, type FinishReason, type ModelEnd, type ModelStream, type ToolCall } from "./types.js";

export interface OpenAICompatibleOptions {
  /** The API's base URL, such as `http://gpu-box:11434/v1` or `https://api.openai.com/v1`. */
  baseUrl: string;
  /** A value or a function resolved on every call; without one no `Authorization` header is sent. */
  apiKey?: string | (() => string | undefined);
  fetch?: typeof fetch;
}

// --- Schemas -------------------------------------------------------------------------------------------

/**
 * The SDK's Gemini-shaped parameter schema as JSON Schema: type names in lower case, `nullable` as a union
 * with `null`, and `description`, `enum`, `format`, `properties`, `required` and `items` kept.
 */
export function toJsonSchema(s: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.type) {
    const type = s.type.toLowerCase();
    out.type = s.nullable ? [type, "null"] : type;
  }
  if (s.description !== undefined) out.description = s.description;
  if (s.enum !== undefined) out.enum = [...s.enum];
  if (s.format !== undefined) out.format = s.format;
  if (s.properties !== undefined) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]));
  if (s.required !== undefined) out.required = [...s.required];
  if (s.items !== undefined) out.items = toJsonSchema(s.items);
  return out;
}

/** A tool's parameters as JSON Schema: a raw schema as it is, an SDK schema converted, none as an empty object. */
export function toolParameters(d: FunctionDeclaration): unknown {
  if (d.parametersJsonSchema !== undefined) return d.parametersJsonSchema;
  if (d.parameters) return toJsonSchema(d.parameters);
  return { type: "object", properties: {} };
}

// --- Server-sent events --------------------------------------------------------------------------------

/**
 * The `data` payloads of a server-sent-events body, one per event (several `data:` lines joined with a
 * newline), until `[DONE]`. Comments and other fields are ignored; a last event without a trailing blank
 * line still counts. Returns whether `[DONE]` was seen.
 */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string, boolean> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line === "") {
        if (data.length) {
          const payload = data.join("\n");
          data = [];
          if (payload === "[DONE]") return true;
          yield payload;
        }
      } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  buffer += decoder.decode();
  const last = buffer.replace(/\r$/, "");
  if (last.startsWith("data:")) data.push(last.slice(5).replace(/^ /, ""));
  if (data.length) {
    const payload = data.join("\n");
    if (payload === "[DONE]") return true;
    yield payload;
  }
  return false;
}

// --- Wire types ----------------------------------------------------------------------------------------

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** Neutral messages as chat-completion messages. Provider data (other adapters' or none) is left out. */
export function toWireMessages(system: string | undefined, messages: ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  if (system !== undefined) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.callId, content: JSON.stringify(m.result) });
    else {
      const calls = (m.toolCalls ?? []).map((c): WireToolCall => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      out.push({ role: "assistant", content: m.text ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  return out;
}

/** The request body for a call; `stream` asks for server-sent events with usage. */
export function toWireRequest(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { model: req.model, messages: toWireMessages(req.system, req.messages) };
  if (req.tools?.length) body.tools = req.tools.map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: toolParameters(d) } }));
  if (req.schema) body.response_format = { type: "json_schema", json_schema: { name: "output", schema: req.schema, strict: false } };
  if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

const usageOf = (u: WireUsage | undefined) => ({ inputTokens: u?.prompt_tokens ?? 0, outputTokens: u?.completion_tokens ?? 0, thoughtTokens: 0 });

/** A chat-completion finish reason in neutral terms; `content_filter` is handled before this. */
function finishOf(reason: string | null | undefined): { finish: FinishReason; providerReason?: string } {
  if (!reason || reason === "stop" || reason === "tool_calls" || reason === "function_call") return { finish: "stop" };
  if (reason === "length") return { finish: "length", providerReason: reason };
  return { finish: "other", providerReason: reason };
}

/** Parses tool-call arguments; undefined when they are not a JSON object. Empty arguments are `{}`. */
function parseArgs(text: string): Record<string, unknown> | undefined {
  if (text.trim() === "") return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const TRANSIENT_STATUS = new Set([408, 500, 502, 503, 504]);
const INVALID_STATUS = new Set([400, 404, 422]);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The wait a 429 asks for: `retry-after-ms`, else `Retry-After` in seconds or as an HTTP date. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.round(Number(ms));
  const after = headers.get("retry-after");
  if (after === null) return undefined;
  if (/^\d+(\.\d+)?$/.test(after.trim())) return Math.round(Number(after) * 1000);
  const at = Date.parse(after);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The adapter itself. */
export class OpenAICompatibleAdapter implements ChatModel {
  private readonly url: string;
  private readonly key: () => string | undefined;
  private readonly fetch: typeof fetch;

  constructor(opts: OpenAICompatibleOptions) {
    this.url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const { apiKey } = opts;
    this.key = typeof apiKey === "function" ? apiKey : () => apiKey;
    this.fetch = opts.fetch ?? fetch;
  }

  async generate(req: ChatRequest, opts: { signal?: AbortSignal } = {}): Promise<ModelEnd> {
    const key = this.key() || undefined;
    const res = await this.post(toWireRequest(req, false), key, opts.signal);
    let body: { model?: string; choices?: Array<{ message?: { content?: string | null; tool_calls?: WireToolCall[] }; finish_reason?: string | null }>; usage?: WireUsage };
    try {
      body = (await res.json()) as typeof body;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new ProviderError("failed", String(res.status), "the server's answer is not JSON", { cause: e });
    }
    const choice = body.choices?.[0];
    const model = body.model || req.model;
    const usage = usageOf(body.usage);
    if (choice?.finish_reason === "content_filter") throw new BlockedError("the model provider blocked the response (content_filter)", "content_filter", model, usage);
    const message: AssistantMessage = { role: "assistant", text: choice?.message?.content ?? "" };
    let { finish, providerReason } = finishOf(choice?.finish_reason);
    const calls: ToolCall[] = [];
    for (const c of choice?.message?.tool_calls ?? []) {
      const args = parseArgs(c.function?.arguments ?? "");
      if (!args) {
        calls.length = 0;
        finish = "malformed_call";
        providerReason = undefined;
        break;
      }
      calls.push({ id: c.id, name: c.function?.name ?? "", args });
    }
    if (calls.length) message.toolCalls = calls;
    return { finish, ...(providerReason ? { providerReason } : {}), model, usage, message };
  }

  async *stream(req: ChatRequest, opts: { signal?: AbortSignal } = {}): ModelStream {
    const key = this.key() || undefined;
    const res = await this.post(toWireRequest(req, true), key, opts.signal);
    if (!res.body) throw new ProviderError("failed", String(res.status), "the server sent no stream");
    let model = req.model;
    let usage = usageOf(undefined);
    let reason: string | null | undefined;
    let text = "";
    /** Tool calls by index: the id and name from the first delta, the argument fragments joined. */
    const pending = new Map<number, { id: string; name: string; args: string }>();
    const events = sseData(res.body as unknown as AsyncIterable<Uint8Array>);
    let done = false;
    try {
      for (;;) {
        const r = await events.next();
        if (r.done) {
          done = r.value;
          break;
        }
        let chunk: {
          model?: string;
          error?: { message?: string };
          usage?: WireUsage | null;
          choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
        };
        try {
          chunk = JSON.parse(r.value);
        } catch (e) {
          throw new ProviderError("failed", "stream", "the server sent an unreadable stream event", { cause: e });
        }
        if (chunk.error) throw new ProviderError("failed", "stream", this.redact(String(chunk.error.message ?? "the server reported an error")).slice(0, 200), { cause: chunk.error });
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = usageOf(chunk.usage);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        // Reasoning output some servers add (`reasoning_content`, `reasoning`) is ignored.
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          yield { kind: "text", text: delta.content };
        }
        for (const d of delta.tool_calls ?? []) {
          const index = d.index ?? 0;
          const call = pending.get(index) ?? { id: "", name: "", args: "" };
          if (d.id) call.id = d.id;
          if (d.function?.name) call.name = d.function.name;
          if (d.function?.arguments) call.args += d.function.arguments;
          pending.set(index, call);
        }
        if (choice.finish_reason) reason = choice.finish_reason;
      }
    } catch (e) {
      if (e instanceof ProviderError || e instanceof LlmError || opts.signal?.aborted) throw e;
      throw new ProviderError("transient", "network", this.redact(messageOf(e)), { cause: e });
    }
    if (!done && !reason) throw new ProviderError("transient", "network", "the stream ended before the answer was complete");
    if (reason === "content_filter") throw new BlockedError("the model provider blocked the response (content_filter)", "content_filter", model, usage);

    let { finish, providerReason } = finishOf(reason);
    const calls: ToolCall[] = [];
    for (const [index, c] of [...pending.entries()].sort(([a], [b]) => a - b)) {
      const args = parseArgs(c.args);
      if (!args) {
        // One unreadable call spoils the round, as Gemini's MALFORMED_FUNCTION_CALL does: none are run.
        calls.length = 0;
        finish = "malformed_call";
        providerReason = undefined;
        break;
      }
      calls.push({ id: c.id || `c${index + 1}`, name: c.name, args });
    }
    for (const call of calls) yield { kind: "call", call };
    const message: AssistantMessage = { role: "assistant" };
    if (text) message.text = text;
    if (calls.length) message.toolCalls = calls;
    return { finish, ...(providerReason ? { providerReason } : {}), model, usage, message };
  }

  /** One POST; HTTP failures become `ProviderError`s, and a key never follows a redirect. */
  private async post(body: Record<string, unknown>, key: string | undefined, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    let res: Response;
    try {
      res = await this.fetch(this.url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", ...(signal ? { signal } : {}) });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new ProviderError("transient", "network", this.redact(messageOf(e)), { cause: e });
    }
    if (res.ok) return res;
    const status = res.status;
    let detail = res.statusText || `HTTP ${status}`;
    try {
      const raw = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      const message = (parsed as { error?: { message?: unknown } | string })?.error;
      detail = typeof message === "string" ? message : typeof message?.message === "string" ? message.message : raw.trim() || detail;
    } catch {
      // The status alone has to do.
    }
    detail = this.redact(detail).slice(0, 200);
    const reason = String(status);
    if (status === 429) {
      const waitMs = retryAfterMs(res.headers);
      throw new ProviderError("rate_limited", reason, detail, waitMs !== undefined ? { waitMs } : {});
    }
    if (TRANSIENT_STATUS.has(status)) throw new ProviderError("transient", reason, detail);
    if (INVALID_STATUS.has(status)) throw new ProviderError("invalid_request", reason, detail);
    throw new ProviderError("failed", reason, detail);
  }

  /** Replaces the key wherever a server or the network echoes it back. */
  private redact(text: string): string {
    const key = this.key();
    return key ? text.split(key).join("[redacted]") : text;
  }
}
