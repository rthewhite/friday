/** A scripted stand-in for `LlmService.streamCall`, for the tool loop and agent runs (provider-neutral). */
import { LlmError } from "@friday/sdk";
import type { StreamCallRequest } from "../src/llm/service.js";
import type { AssistantMessage, FinishReason, ModelEnd, StreamChunk, ToolCall } from "../src/llm/types.js";

export const text = (t: string): StreamChunk => ({ kind: "text", text: t });
export const thought = (t: string): StreamChunk => ({ kind: "thought", text: t });
/** A tool call; its id defaults to `c<n>`, numbered within the round. */
export const call = (name: string, args: Record<string, unknown> = {}, id?: string): StreamChunk => ({ kind: "call", call: { id: id ?? "", name, args } });

/** One model call: its chunks, plus optional finish reason, token usage and a wait (aborted by the request's signal). */
export interface Round {
  chunks?: StreamChunk[];
  finish?: FinishReason;
  providerReason?: string;
  tokens?: { input: number; output: number };
  /** Milliseconds to wait before answering; `Infinity` waits for the abort. */
  waitMs?: number;
  /** Rejects after streaming `chunks`, instead of answering. */
  error?: Error;
}

/** Plays one round per call (the last repeats), snapshotting each request. `active` counts calls in flight. */
export function fakeStream(...rounds: Round[]) {
  const requests: StreamCallRequest[] = [];
  const owners: string[] = [];
  const state = { active: 0, maxActive: 0 };
  const llm = {
    async streamCall(owner: string, req: StreamCallRequest, onChunk: (c: StreamChunk) => void): Promise<ModelEnd> {
      owners.push(owner);
      const { signal, ...rest } = req;
      requests.push(JSON.parse(JSON.stringify(rest)));
      const round = rounds[Math.min(requests.length - 1, rounds.length - 1)];
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (round.waitMs) await wait(round.waitMs, signal);
        let text = "";
        const calls: ToolCall[] = [];
        for (const c of round.chunks ?? []) {
          const chunk: StreamChunk = c.kind === "call" ? { kind: "call", call: { ...c.call, id: c.call.id || `c${calls.length + 1}` } } : c;
          if (chunk.kind === "text") text += chunk.text;
          if (chunk.kind === "call") calls.push(chunk.call);
          onChunk(chunk);
        }
        if (round.error) throw round.error;
        const usage = { inputTokens: round.tokens?.input ?? 1, outputTokens: round.tokens?.output ?? 1, thoughtTokens: 0 };
        const message: AssistantMessage = { role: "assistant" };
        if (text) message.text = text;
        if (calls.length) message.toolCalls = calls;
        return { finish: round.finish ?? "stop", ...(round.providerReason ? { providerReason: round.providerReason } : {}), model: req.model, usage, message };
      } finally {
        state.active--;
      }
    },
  };
  return { llm, requests, owners, state };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new LlmError("cancelled", "the call was cancelled"));
    if (signal?.aborted) return abort();
    const timer = Number.isFinite(ms) ? setTimeout(resolve, ms) : undefined;
    signal?.addEventListener("abort", () => (clearTimeout(timer), abort()), { once: true });
  });
}
