/**
 * Core's text model: one non-Live `generateContent` call per request. `TextModel` is the seam
 * `LlmService` (queue, retries, timeout, validation, logging) and a later chat engine build on.
 */
import { GoogleGenAI, type Content, type GenerateContentConfig, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import { LlmError, type JsonSchema, type LlmMessage, type LlmUsage } from "@friday/sdk";

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
}

/** The part of `GoogleGenAI.models` this provider uses; tests inject a stub. */
export type GenerateContent = (params: GenerateContentParameters) => Promise<GenerateContentResponse>;

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
  private client?: GenerateContent;

  /** `generateContent` defaults to `new GoogleGenAI({ apiKey }).models.generateContent`, created on first use. */
  constructor(private readonly apiKey: string, generateContent?: GenerateContent) {
    this.client = generateContent;
  }

  async generate(req: TextRequest, opts: { signal?: AbortSignal } = {}): Promise<TextResponse> {
    if (!this.apiKey) throw new LlmError("unavailable", "GEMINI_API_KEY is not configured");
    if (!this.client) {
      const ai = new GoogleGenAI({ apiKey: this.apiKey });
      this.client = (p) => ai.models.generateContent(p);
    }
    return fromGeminiResponse(await this.client(toGeminiParams(req, opts.signal)), req.model);
  }
}
