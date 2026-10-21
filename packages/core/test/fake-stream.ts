/** A scripted stand-in for `LlmService.streamCall`, for the tool loop and agent runs. */
import { LlmError } from "@friday/sdk";
import type { StreamChunk, StreamEnd } from "../src/llm/gemini.js";
import type { StreamCallRequest } from "../src/llm/service.js";

export const text = (t: string, extra: object = {}): StreamChunk => ({ kind: "text", text: t, part: { text: t, ...extra } });
export const thought = (t: string): StreamChunk => ({ kind: "thought", text: t, part: { text: t, thought: true } });
export const call = (name: string, args: Record<string, unknown> = {}, sig?: string): StreamChunk => ({
  kind: "call", name, args, part: { functionCall: { name, args }, ...(sig ? { thoughtSignature: sig } : {}) },
});

/** One model call: its chunks, plus optional finish reason, token usage and a wait (aborted by the request's signal). */
export interface Round {
  chunks?: StreamChunk[];
  finish?: string;
  tokens?: { input: number; output: number };
  /** Milliseconds to wait before answering; `Infinity` waits for the abort. */
  waitMs?: number;
  /** Rejects instead of answering. */
  error?: Error;
}

/** Plays one round per call (the last repeats), snapshotting each request. `active` counts calls in flight. */
export function fakeStream(...rounds: Round[]) {
  const requests: StreamCallRequest[] = [];
  const owners: string[] = [];
  const state = { active: 0, maxActive: 0 };
  const llm = {
    async streamCall(owner: string, req: StreamCallRequest, onChunk: (c: StreamChunk) => void): Promise<StreamEnd> {
      owners.push(owner);
      const { signal, ...rest } = req;
      requests.push(JSON.parse(JSON.stringify(rest)));
      const round = rounds[Math.min(requests.length - 1, rounds.length - 1)];
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (round.waitMs) await wait(round.waitMs, signal);
        if (round.error) throw round.error;
        for (const c of round.chunks ?? []) onChunk(c);
        const usage = { inputTokens: round.tokens?.input ?? 1, outputTokens: round.tokens?.output ?? 1, thoughtTokens: 0 };
        return { finishReason: round.finish ?? "STOP", model: req.model, usage };
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
