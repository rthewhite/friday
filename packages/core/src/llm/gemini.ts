/**
 * Core's text model: one non-Live `generateContent` call per request, or a streamed call with tools
 * (`stream`) for chat turns. `TextModel` is the seam `LlmService` (queue, retries, timeout,
 * validation, logging) and the chat engine build on.
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
import { LlmError, type JsonSchema, type LlmMessage, type LlmUsage } from "@friday/sdk";

/** A streamed call: the caller owns the contents (history, tool turns) it sends. */
export interface StreamRequest {
  /** Resolved model name. */
  model: string;
  system?: string;
  contents: Content[];
  /** Function declarations the model may call; none means no tools. */
  tools?: FunctionDeclaration[];
  /** Ask for thought summaries (streamed as `thought` chunks). */
  thoughts?: boolean;
}

/**
 * One streamed piece. Every part keeps the provider's `Part` verbatim (thought signatures included),
 * so the caller can send the model's turn back unchanged within the same chat turn.
 */
export type StreamChunk =
  | { kind: "thought"; text: string; part: Part }
  | { kind: "text"; text: string; part: Part }
  | { kind: "call"; name: string; args: Record<string, unknown>; part: Part }
  /** A part with nothing to show, such as a bare thought signature. */
  | { kind: "other"; part: Part };

/** How a streamed call ended. */
export interface StreamEnd {
  finishReason?: string;
  blockReason?: string;
  model: string;
  usage: Required<LlmUsage>;
}

/** Streamed chunks, then the end as the iterator's return value. */
export type TextStream = AsyncGenerator<StreamChunk, StreamEnd>;

export interface TextRequest {
  /** Resolved model name (tiers are mapped by the caller). */
  model: string;
  system?: string;
  prompt?: string;
  messages?: LlmMessage[];
  schema?: JsonSchema;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface TextResponse {
  text: string;
  finishReason?: string;
  /** Set when the provider refused the prompt itself. */
  blockReason?: string;
  /** The model version that answered, as reported by the provider. */
  model: string;
  usage: Required<LlmUsage>;
}

export interface TextModel {
  generate(req: TextRequest, opts?: { signal?: AbortSignal }): Promise<TextResponse>;
  /** Streamed call with tools; providers without streaming leave it out. */
  stream?(req: StreamRequest, opts?: { signal?: AbortSignal }): TextStream;
}

/** The part of `GoogleGenAI.models` this provider uses; tests inject a stub. */
export type GenerateContent = (params: GenerateContentParameters) => Promise<GenerateContentResponse>;
/** `GoogleGenAI.models.generateContentStream`; tests inject a stub. */
export type GenerateContentStream = (params: GenerateContentParameters) => Promise<AsyncIterable<GenerateContentResponse>>;

/** Builds the `generateContentStream` parameters for a streamed request. */
export function toStreamParams(req: StreamRequest, signal?: AbortSignal): GenerateContentParameters {
  const config: GenerateContentConfig = {};
  if (req.system !== undefined) config.systemInstruction = req.system;
  if (req.tools?.length) config.tools = [{ functionDeclarations: req.tools }];
  if (req.thoughts) config.thinkingConfig = { includeThoughts: true };
  if (signal) config.abortSignal = signal;
  return { model: req.model, contents: req.contents, config };
}

/** Turns one provider part into a chunk. */
function chunkOf(part: Part): StreamChunk {
  if (part.functionCall) return { kind: "call", name: part.functionCall.name ?? "", args: part.functionCall.args ?? {}, part };
  if (typeof part.text === "string" && part.text) return part.thought ? { kind: "thought", text: part.text, part } : { kind: "text", text: part.text, part };
  return { kind: "other", part };
}

/** Builds the `generateContent` parameters for a request. */
export function toGeminiParams(req: TextRequest, signal?: AbortSignal): GenerateContentParameters {
  const contents: Content[] = req.messages
    ? req.messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] }))
    : [{ role: "user", parts: [{ text: req.prompt ?? "" }] }];
  const config: GenerateContentConfig = {};
  if (req.system !== undefined) config.systemInstruction = req.system;
  if (req.temperature !== undefined) config.temperature = req.temperature;
  if (req.maxOutputTokens !== undefined) config.maxOutputTokens = req.maxOutputTokens;
  if (req.schema) {
    config.responseMimeType = "application/json";
    config.responseJsonSchema = req.schema;
  }
  if (signal) config.abortSignal = signal;
  return { model: req.model, contents, config };
}

/** Reads text (thought parts excluded), reasons, model version and usage from a response. */
export function fromGeminiResponse(res: GenerateContentResponse, requested: string): TextResponse {
  const candidate = res.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
  const u = res.usageMetadata;
  return {
    text,
    ...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}),
    ...(res.promptFeedback?.blockReason ? { blockReason: res.promptFeedback.blockReason } : {}),
    model: res.modelVersion || requested,
    usage: { inputTokens: u?.promptTokenCount ?? 0, outputTokens: u?.candidatesTokenCount ?? 0, thoughtTokens: u?.thoughtsTokenCount ?? 0 },
  };
}

export class GeminiTextModel implements TextModel {
  private readonly key: () => string | undefined;
  private client?: { apiKey: string; generate: GenerateContent };
  private streamer?: { apiKey: string; stream: GenerateContentStream };

  /**
   * `apiKey` is a value or a function resolved on every call (core config: core scope, global, env).
   * `generateContent`, when given, serves every key (tests). Otherwise `clientFor` builds one client
   * per key value, reused until the resolved key changes; `streamFor` does the same for streamed calls.
   */
  constructor(
    apiKey: string | (() => string | undefined),
    private readonly generateContent?: GenerateContent,
    private readonly clientFor: (apiKey: string) => GenerateContent = (key) => {
      const ai = new GoogleGenAI({ apiKey: key });
      return (p) => ai.models.generateContent(p);
    },
    private readonly streamFor: (apiKey: string) => GenerateContentStream = (key) => {
      const ai = new GoogleGenAI({ apiKey: key });
      return (p) => ai.models.generateContentStream(p);
    },
  ) {
    this.key = typeof apiKey === "function" ? apiKey : () => apiKey;
  }

  async generate(req: TextRequest, opts: { signal?: AbortSignal } = {}): Promise<TextResponse> {
    const apiKey = this.requireKey();
    let generate = this.generateContent;
    if (!generate) {
      if (this.client?.apiKey !== apiKey) this.client = { apiKey, generate: this.clientFor(apiKey) };
      generate = this.client.generate;
    }
    return fromGeminiResponse(await generate(toGeminiParams(req, opts.signal)), req.model);
  }

  async *stream(req: StreamRequest, opts: { signal?: AbortSignal } = {}): TextStream {
    const apiKey = this.requireKey();
    if (this.streamer?.apiKey !== apiKey) this.streamer = { apiKey, stream: this.streamFor(apiKey) };
    const end: StreamEnd = { model: req.model, usage: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0 } };
    for await (const res of await this.streamer.stream(toStreamParams(req, opts.signal))) {
      const candidate = res.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) yield chunkOf(part);
      if (candidate?.finishReason) end.finishReason = candidate.finishReason;
      if (res.promptFeedback?.blockReason) end.blockReason = res.promptFeedback.blockReason;
      if (res.modelVersion) end.model = res.modelVersion;
      // Usage is cumulative; the last chunk carrying it has the totals.
      const u = res.usageMetadata;
      if (u) end.usage = { inputTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0, thoughtTokens: u.thoughtsTokenCount ?? 0 };
    }
    return end;
  }

  private requireKey(): string {
    const apiKey = this.key();
    if (!apiKey) throw new LlmError("unavailable", "GEMINI_API_KEY is not configured");
    return apiKey;
  }
}
