/**
 * The Gemini adapter (llm-adapters): core's provider-neutral requests (`ChatRequest`) mapped to Gemini's
 * non-Live `generateContent` and `generateContentStream`, and Gemini's responses and failures mapped back.
 * Gemini's extras stay here: the model's parts (thought signatures included) travel as provider data on
 * the assistant message, and its rate-limit details and safety reasons become neutral errors.
 */
import {
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import { LlmError, type LlmUsage } from "@friday/sdk";
import { BlockedError, ProviderError, type AssistantMessage, type ChatMessage, type ChatModel, type ChatRequest, type FinishReason, type ModelEnd, type ModelStream, type ToolCall } from "./types.js";

/** The part of `GoogleGenAI.models` this provider uses; tests inject a stub. */
export type GenerateContent = (params: GenerateContentParameters) => Promise<GenerateContentResponse>;
/** `GoogleGenAI.models.generateContentStream`; tests inject a stub. */
export type GenerateContentStream = (params: GenerateContentParameters) => Promise<AsyncIterable<GenerateContentResponse>>;

/** Finish reasons that mean Gemini stopped the answer for safety or policy. */
export const BLOCKING_FINISH = new Set(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "OTHER", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"]);

/** Gemini's finish reasons in neutral terms; blocking reasons are handled before this. */
function finishOf(reason: string | undefined): { finish: FinishReason; providerReason?: string } {
  if (!reason || reason === "STOP") return { finish: "stop" };
  if (reason === "MAX_TOKENS") return { finish: "length", providerReason: reason };
  if (reason === "MALFORMED_FUNCTION_CALL") return { finish: "malformed_call", providerReason: reason };
  return { finish: "other", providerReason: reason };
}

/** Throws `blocked` when Gemini refused the prompt or stopped the response for safety or policy. */
function throwIfBlocked(res: { blockReason?: string; finishReason?: string }, model: string, usage: Required<LlmUsage>): void {
  const reason = res.blockReason ?? (res.finishReason && BLOCKING_FINISH.has(res.finishReason) ? res.finishReason : undefined);
  if (reason) throw new BlockedError(`the model provider blocked the ${res.blockReason ? "prompt" : "response"} (${reason})`, reason, model, usage);
}

export interface RateLimitInfo {
  /** The provider's `RetryInfo.retryDelay`, in ms. */
  waitMs?: number;
  /** The exhausted quota (`QuotaFailure` quota id or metric); a daily one when any violation is per day. */
  quota?: string;
}

/**
 * Reads Gemini's 429 body, which the SDK puts JSON-encoded in `ApiError.message`. Best-effort:
 * anything unexpected yields `{}` and the fixed backoff applies.
 */
export function rateLimitInfo(msg: string): RateLimitInfo {
  let details: unknown;
  try {
    details = (JSON.parse(msg) as { error?: { details?: unknown } })?.error?.details;
  } catch {
    return {};
  }
  if (!Array.isArray(details)) return {};
  const out: RateLimitInfo = {};
  for (const d of details as Array<Record<string, unknown>>) {
    const type = typeof d?.["@type"] === "string" ? (d["@type"] as string) : "";
    if (out.waitMs === undefined && type.endsWith("RetryInfo")) {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d.retryDelay ?? ""));
      if (m) out.waitMs = Math.round(Number(m[1]) * 1000);
    }
    if (out.quota === undefined && type.endsWith("QuotaFailure") && Array.isArray(d.violations)) {
      const names = (d.violations as Array<Record<string, unknown>>)
        .map((v) => (typeof v?.quotaId === "string" ? v.quotaId : typeof v?.quotaMetric === "string" ? v.quotaMetric : undefined))
        .filter((n): n is string => !!n);
      out.quota = names.find(isDaily) ?? names[0];
    }
  }
  return out;
}

export const isDaily = (quota: string) => /perday/i.test(quota);

const TRANSIENT_STATUS = new Set([408, 500, 502, 503, 504]);
const INVALID_STATUS = new Set([400, 404, 422]);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Maps a Gemini SDK failure to a neutral one. Our own errors (`LlmError`, `ProviderError`) pass through. */
export function geminiFailure(e: unknown): unknown {
  if (e instanceof LlmError || e instanceof ProviderError) return e;
  const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : undefined;
  const msg = messageOf(e);
  if (status === undefined) return new ProviderError("transient", "network", msg, { cause: e });
  const reason = String(status);
  if (status === 429) {
    const info = rateLimitInfo(msg);
    return new ProviderError("rate_limited", reason, msg, { ...info, ...(info.quota ? { daily: isDaily(info.quota) } : {}), cause: e });
  }
  if (TRANSIENT_STATUS.has(status)) return new ProviderError("transient", reason, msg, { cause: e });
  if (INVALID_STATUS.has(status)) return new ProviderError("invalid_request", reason, msg, { cause: e });
  return new ProviderError("failed", reason, msg, { cause: e });
}

/**
 * Neutral messages as Gemini contents. A user text joins a user text before it, a tool result joins the
 * results before it, and a model turn joins the model turn before it ("a model turn holds its text and the
 * call after it"). An assistant message carrying Gemini provider data is sent as its parts, verbatim; ids
 * go in `functionCall` and `functionResponse` only when Gemini supplied them. Other adapters' data is left out.
 */
export function toGeminiContents(messages: ChatMessage[]): Content[] {
  type Kind = "text" | "responses" | "model";
  const out: { kind: Kind; content: Content }[] = [];
  const geminiIds = new Set<string>();
  const push = (role: "user" | "model", kind: Kind, parts: Part[]) => {
    if (!parts.length) return;
    const last = out.at(-1);
    if (last && last.content.role === role && last.kind === kind) last.content.parts!.push(...parts);
    else out.push({ kind, content: { role, parts } });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", "text", [{ text: m.text }]);
    else if (m.role === "tool") {
      const id = geminiIds.has(m.callId) ? { id: m.callId } : {};
      push("user", "responses", [{ functionResponse: { ...id, name: m.name, response: m.result } }]);
    } else if (m.providerData?.adapter === "gemini") {
      const parts = structuredClone(m.providerData.value as Part[]);
      for (const p of parts) if (p.functionCall?.id) geminiIds.add(p.functionCall.id);
      push("model", "model", parts);
    } else {
      const parts: Part[] = [];
      if (m.text !== undefined) parts.push({ text: m.text });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args } });
      push("model", "model", parts);
    }
  }
  return out.map((o) => o.content);
}

/** Builds the Gemini parameters for a neutral request (one-shot or streamed). */
export function geminiParams(req: ChatRequest, signal?: AbortSignal): GenerateContentParameters {
  const config: GenerateContentConfig = {};
  if (req.system !== undefined) config.systemInstruction = req.system;
  if (req.temperature !== undefined) config.temperature = req.temperature;
  if (req.maxOutputTokens !== undefined) config.maxOutputTokens = req.maxOutputTokens;
  if (req.schema) {
    config.responseMimeType = "application/json";
    config.responseJsonSchema = req.schema;
  }
  // The SDK's declarations are a structural subset of Gemini's; they go as they are.
  if (req.tools?.length) config.tools = [{ functionDeclarations: req.tools as FunctionDeclaration[] }];
  if (req.thoughts) config.thinkingConfig = { includeThoughts: true };
  if (signal) config.abortSignal = signal;
  return { model: req.model, contents: toGeminiContents(req.messages), config };
}

const usageOf = (u: GenerateContentResponse["usageMetadata"]): Required<LlmUsage> => ({
  inputTokens: u?.promptTokenCount ?? 0,
  outputTokens: u?.candidatesTokenCount ?? 0,
  thoughtTokens: u?.thoughtsTokenCount ?? 0,
});

/** Core's `ChatModel` on Gemini (non-Live `generateContent` and `generateContentStream`). */
export class GeminiAdapter implements ChatModel {
  private readonly key: () => string | undefined;
  /** The provider functions for the key they were built for; rebuilt when the resolved key changes. */
  private client?: { apiKey: string; generate: GenerateContent; stream: GenerateContentStream };

  /**
   * `apiKey` is a value or a function resolved on every call (core config: core scope, global, env).
   * `generateContent`, when given, serves every key (tests). Otherwise one `GoogleGenAI` per key value
   * serves both calls, reused until the resolved key changes; tests replace it per call kind with
   * `clientFor` and `streamFor`.
   */
  constructor(
    apiKey: string | (() => string | undefined),
    private readonly generateContent?: GenerateContent,
    private readonly clientFor?: (apiKey: string) => GenerateContent,
    private readonly streamFor?: (apiKey: string) => GenerateContentStream,
  ) {
    this.key = typeof apiKey === "function" ? apiKey : () => apiKey;
  }

  async generate(req: ChatRequest, opts: { signal?: AbortSignal } = {}): Promise<ModelEnd> {
    const apiKey = this.requireKey();
    const generate = this.generateContent ?? this.clientOf(apiKey).generate;
    let res: GenerateContentResponse;
    try {
      res = await generate(geminiParams(req, opts.signal));
    } catch (e) {
      throw geminiFailure(e);
    }
    const candidate = res.candidates?.[0];
    const model = res.modelVersion || req.model;
    const usage = usageOf(res.usageMetadata);
    throwIfBlocked({ blockReason: res.promptFeedback?.blockReason, finishReason: candidate?.finishReason }, model, usage);
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("");
    return { ...finishOf(candidate?.finishReason), model, usage, message: { role: "assistant", text } };
  }

  async *stream(req: ChatRequest, opts: { signal?: AbortSignal } = {}): ModelStream {
    const stream = this.clientOf(this.requireKey()).stream;
    let model = req.model;
    let usage = usageOf(undefined);
    let finishReason: string | undefined;
    let blockReason: string | undefined;
    const parts: Part[] = [];
    const calls: ToolCall[] = [];
    let text = "";
    let n = 0;
    let responses: AsyncIterable<GenerateContentResponse>;
    try {
      responses = await stream(geminiParams(req, opts.signal));
    } catch (e) {
      throw geminiFailure(e);
    }
    try {
      for await (const res of responses) {
        const candidate = res.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (part.thought && typeof part.text === "string" && part.text) {
            if (req.thoughts) yield { kind: "thought", text: part.text };
            continue;
          }
          // Everything but thought summaries goes back verbatim: text, calls and bare thought signatures.
          parts.push(part);
          if (part.functionCall) {
            const call = { id: part.functionCall.id || `c${++n}`, name: part.functionCall.name ?? "", args: part.functionCall.args ?? {} };
            calls.push(call);
            yield { kind: "call", call };
          } else if (typeof part.text === "string" && part.text) {
            text += part.text;
            yield { kind: "text", text: part.text };
          }
        }
        if (candidate?.finishReason) finishReason = candidate.finishReason;
        if (res.promptFeedback?.blockReason) blockReason = res.promptFeedback.blockReason;
        if (res.modelVersion) model = res.modelVersion;
        // Usage is cumulative; the last chunk carrying it has the totals.
        if (res.usageMetadata) usage = usageOf(res.usageMetadata);
      }
    } catch (e) {
      throw geminiFailure(e);
    }
    throwIfBlocked({ blockReason, finishReason }, model, usage);
    const message: AssistantMessage = { role: "assistant", providerData: { adapter: "gemini", value: parts } };
    if (text) message.text = text;
    if (calls.length) message.toolCalls = calls;
    return { ...finishOf(finishReason), model, usage, message };
  }

  private clientOf(apiKey: string) {
    if (this.client?.apiKey !== apiKey) {
      let ai: GoogleGenAI | undefined;
      const sdk = () => (ai ??= new GoogleGenAI({ apiKey }));
      this.client = {
        apiKey,
        generate: this.clientFor?.(apiKey) ?? ((p) => sdk().models.generateContent(p)),
        stream: this.streamFor?.(apiKey) ?? ((p) => sdk().models.generateContentStream(p)),
      };
    }
    return this.client;
  }

  private requireKey(): string {
    const apiKey = this.key();
    if (!apiKey) throw new LlmError("unavailable", "GEMINI_API_KEY is not configured");
    return apiKey;
  }
}
