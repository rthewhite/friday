/**
 * Scripted providers for both adapters (llm-adapters): one neutral script per model call, played as that
 * provider's raw responses (Gemini: stubbed `generateContent`/`generateContentStream`; OpenAI: an injected
 * `fetch` with JSON or server-sent events), with the raw requests kept for inspection.
 */
import { ApiError, type GenerateContentParameters, type GenerateContentResponse, type Part } from "@google/genai";
import { GeminiAdapter } from "../src/llm/gemini.js";
import { OpenAICompatibleAdapter } from "../src/llm/openai.js";
import type { ChatModel } from "../src/llm/types.js";

/** What the model does in one call, in neutral terms. */
export interface Round {
  thoughts?: string[];
  text?: string[];
  calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  finish?: "stop" | "length" | "malformed" | "blocked";
  /** `null`: the provider reports no usage. */
  usage?: { input: number; output: number } | null;
}
/** A provider failure instead of an answer. */
export type Failure = { fail: "429"; waitS: number } | { fail: "503" } | { fail: "401" } | { fail: "network" };
export type Step = Round | Failure;

export interface Harness {
  name: "gemini" | "openai";
  /** Whether the provider streams thought summaries at all. */
  thoughts: boolean;
  /** An adapter playing one step per call (the last repeats), and the requests it sent, raw. */
  make(...steps: Step[]): { model: ChatModel; sent: unknown[] };
  /** The tool results in a raw request: each with the id (when the provider uses one) and name of the call it answers. */
  results(raw: unknown): Array<{ callId?: string; name: string; result: unknown }>;
  /** The output schema in a raw request. */
  schema(raw: unknown): unknown;
}

const isFailure = (s: Step): s is Failure => "fail" in s;

// --- Gemini --------------------------------------------------------------------------------------------

const geminiFinish = { stop: "STOP", length: "MAX_TOKENS", malformed: "MALFORMED_FUNCTION_CALL", blocked: "SAFETY" } as const;

function geminiError(f: Failure): Error {
  if (f.fail === "network") return new TypeError("fetch failed");
  if (f.fail === "429") return new ApiError({ status: 429, message: JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: `${f.waitS}s` }] } }) });
  return new ApiError({ status: Number(f.fail), message: `status ${f.fail}` });
}

function geminiResponses(r: Round): GenerateContentResponse[] {
  const parts: Part[] = [
    ...(r.thoughts ?? []).map((t) => ({ text: t, thought: true })),
    ...(r.text ?? []).map((t) => ({ text: t })),
    ...(r.calls ?? []).map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.args } })),
  ];
  const out = parts.map((p) => ({ candidates: [{ content: { role: "model", parts: [p] } }] }) as GenerateContentResponse);
  const usage = r.usage === null ? {} : { usageMetadata: { promptTokenCount: r.usage?.input ?? 10, candidatesTokenCount: r.usage?.output ?? 2 } };
  out.push({ candidates: [{ finishReason: geminiFinish[r.finish ?? "stop"] }], ...usage } as GenerateContentResponse);
  return out;
}

export const gemini: Harness = {
  name: "gemini",
  thoughts: true,
  make(...steps) {
    const sent: GenerateContentParameters[] = [];
    const step = () => steps[Math.min(sent.length - 1, steps.length - 1)];
    const model = new GeminiAdapter(
      "k",
      async (p) => {
        sent.push(p);
        const s = step();
        if (isFailure(s)) throw geminiError(s);
        const responses = geminiResponses(s);
        // One response holding every part, as generateContent answers.
        const parts = responses.flatMap((r) => r.candidates?.[0]?.content?.parts ?? []);
        const last = responses.at(-1)!;
        return { candidates: [{ content: { role: "model", parts }, finishReason: last.candidates![0].finishReason }], usageMetadata: last.usageMetadata } as GenerateContentResponse;
      },
      undefined,
      () => async (p) => {
        sent.push(p);
        const s = step();
        if (isFailure(s)) throw geminiError(s);
        const responses = geminiResponses(s);
        return (async function* () {
          yield* responses;
        })();
      },
    );
    return { model, sent };
  },
  results(raw) {
    const contents = (raw as GenerateContentParameters).contents as Array<{ parts?: Part[] }>;
    return contents.flatMap((c) => c.parts ?? []).filter((p) => p.functionResponse).map((p) => ({ callId: p.functionResponse!.id, name: p.functionResponse!.name!, result: p.functionResponse!.response }));
  },
  schema: (raw) => (raw as GenerateContentParameters).config?.responseJsonSchema,
};

// --- OpenAI-compatible ---------------------------------------------------------------------------------

const openaiFinish = { stop: "stop", length: "length", malformed: "tool_calls", blocked: "content_filter" } as const;

function openaiFailure(f: Failure): Response | Error {
  if (f.fail === "network") return new TypeError("fetch failed");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (f.fail === "429") headers["retry-after"] = String(f.waitS);
  return new Response(JSON.stringify({ error: { message: `status ${f.fail}` } }), { status: Number(f.fail), headers });
}

function openaiEvents(r: Round): unknown[] {
  const d = (delta: Record<string, unknown>, finish: string | null = null) => ({ model: "m", choices: [{ index: 0, delta, finish_reason: finish }] });
  const events: unknown[] = [
    ...(r.thoughts ?? []).map((t) => d({ reasoning_content: t })),
    ...(r.text ?? []).map((t) => d({ content: t })),
    ...(r.calls ?? []).map((c, index) => d({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.name, arguments: r.finish === "malformed" ? '{"cut": ' : JSON.stringify(c.args) } }] })),
    d({}, r.calls?.length && r.finish !== "length" ? "tool_calls" : openaiFinish[r.finish ?? "stop"]),
  ];
  if (r.usage !== null) events.push({ model: "m", choices: [], usage: { prompt_tokens: r.usage?.input ?? 10, completion_tokens: r.usage?.output ?? 2 } });
  return events;
}

export const openai: Harness = {
  name: "openai",
  thoughts: false,
  make(...steps) {
    const sent: Array<Record<string, any>> = [];
    const fetchFn = (async (_url: string | URL | Request, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      const s = steps[Math.min(sent.length - 1, steps.length - 1)];
      if (isFailure(s)) {
        const f = openaiFailure(s);
        if (f instanceof Error) throw f;
        return f;
      }
      if (!body.stream) {
        const calls = (s.calls ?? []).map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: s.finish === "malformed" ? "{bad" : JSON.stringify(c.args) } }));
        const message = { role: "assistant", content: (s.text ?? []).join(""), ...(calls.length ? { tool_calls: calls } : {}) };
        const usage = s.usage === null ? {} : { usage: { prompt_tokens: s.usage?.input ?? 10, completion_tokens: s.usage?.output ?? 2 } };
        return new Response(JSON.stringify({ model: "m", choices: [{ index: 0, message, finish_reason: openaiFinish[s.finish ?? "stop"] }], ...usage }), { headers: { "content-type": "application/json" } });
      }
      const text = openaiEvents(s).map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(text, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    return { model: new OpenAICompatibleAdapter({ baseUrl: "http://llm.test/v1", fetch: fetchFn }), sent };
  },
  results(raw) {
    const messages = (raw as { messages: Array<Record<string, any>> }).messages;
    return messages
      .filter((m) => m.role === "tool")
      .map((m) => {
        const call = messages.flatMap((x) => x.tool_calls ?? []).find((c: any) => c.id === m.tool_call_id);
        return { callId: m.tool_call_id, name: call?.function?.name, result: JSON.parse(m.content) };
      });
  },
  schema: (raw) => (raw as { response_format?: { json_schema?: { schema?: unknown } } }).response_format?.json_schema?.schema,
};

export const harnesses: Harness[] = [gemini, openai];
