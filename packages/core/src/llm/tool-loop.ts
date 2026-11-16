/**
 * The model and tool loop shared by portal chat and agent runs:
 *   model round (streamed) -> tool calls of that round, in parallel -> results back -> next round ...
 * until a round has no calls. Within the loop the model's turn goes back as the adapter returned it
 * (for Gemini: its parts, thought signatures kept, thought summaries dropped), followed by one tool
 * message per call. Callers decide which tools run and when to stop (`beforeRound`, `beforeCalls`);
 * the loop never records anything itself.
 */
import { LlmError, type FunctionDeclaration } from "@friday/sdk";
import type { LlmService } from "./service.js";
import type { ChatMessage, FinishReason, ModelEnd } from "./types.js";

export interface LoopCall {
  /** Numbers the loop's calls from 1, so a result can be matched to its call whatever order they settle in. */
  id: number;
  /** The call's id in the request, which pairs it with its tool message. */
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LoopState {
  /** Rounds whose calls were run. */
  rounds: number;
  /** Calls that were run. */
  calls: number;
  /** Input and output tokens of every model call that completed. */
  tokens: number;
  /** Whether any text was streamed. */
  streamed: boolean;
}

/** Why a caller stopped the loop. */
export interface LoopStop {
  kind: string;
  message: string;
}

export type LoopOutcome =
  /** The model answered without calls; `text` is that last round's text. */
  | { kind: "done"; text: string }
  /** A caller's stop; `unrun` are the calls the model asked for that were not run (none before a round). */
  | { kind: "stopped"; stop: LoopStop; unrun: LoopCall[] }
  /** The signal was aborted: before a round, or during a model call. */
  | { kind: "aborted" }
  | { kind: "failed"; error: LlmError }
  /** A round without calls ended for another reason than `stop` (cut off, malformed call, ...). */
  | { kind: "unfinished"; message: string };

export interface ToolLoopOptions {
  llm: Pick<LlmService, "streamCall">;
  /** Usage-log owner of every model call (`chat`, `agent:<name>`). */
  owner: string;
  model: string;
  system: string;
  /** History to send; the loop appends the model turns and tool results of this loop to it. */
  messages: ChatMessage[];
  tools: FunctionDeclaration[];
  thoughts?: boolean;
  signal?: AbortSignal;
  /** Runs before every model call; holding a gate (agents) is the caller's business. */
  around?: <T>(call: () => Promise<T>) => Promise<T>;
  onThought?(text: string): void;
  onText?(text: string): void;
  onCall?(call: LoopCall): void;
  /** Runs one call; must settle (timeouts are the caller's). */
  callTool(call: LoopCall): Promise<Record<string, unknown>>;
  /** Checked before each model call. */
  beforeRound?(state: LoopState): LoopStop | undefined;
  /** Checked before a round's calls run; a stop leaves all of them unrun. */
  beforeCalls?(calls: LoopCall[], state: LoopState): LoopStop | undefined;
}

/** Why a round without calls ended before its answer was complete. */
export function unfinished(finish: Exclude<FinishReason, "stop">, providerReason?: string): string {
  if (finish === "length") return "the answer was cut off at the output limit";
  if (finish === "malformed_call") return "the model produced a malformed tool call";
  return `the model stopped without finishing (${providerReason ?? "unknown reason"})`;
}

export async function runToolLoop(o: ToolLoopOptions): Promise<{ outcome: LoopOutcome; state: LoopState }> {
  const state: LoopState = { rounds: 0, calls: 0, tokens: 0, streamed: false };
  const finish = (outcome: LoopOutcome) => ({ outcome, state });
  const around = o.around ?? ((call) => call());
  let seq = 0;
  for (;;) {
    if (o.signal?.aborted) return finish({ kind: "aborted" });
    const before = o.beforeRound?.(state);
    if (before) return finish({ kind: "stopped", stop: before, unrun: [] });

    const calls: LoopCall[] = [];
    let text = "";
    let end: ModelEnd;
    try {
      end = await around(() =>
        o.llm.streamCall(o.owner, { model: o.model, system: o.system, messages: o.messages, tools: o.tools, thoughts: o.thoughts, signal: o.signal }, (c) => {
          if (c.kind === "thought") return o.onThought?.(c.text);
          if (c.kind === "text") {
            state.streamed = true;
            text += c.text;
            o.onText?.(c.text);
          } else if (c.kind === "call") {
            const call = { id: ++seq, callId: c.call.id, name: c.call.name, args: c.call.args };
            calls.push(call);
            o.onCall?.(call);
          }
        }),
      );
    } catch (e) {
      if (o.signal?.aborted) return finish({ kind: "aborted" });
      return finish({ kind: "failed", error: e instanceof LlmError ? e : new LlmError("unavailable", e instanceof Error ? e.message : String(e)) });
    }
    state.tokens += end.usage.inputTokens + end.usage.outputTokens;

    if (!calls.length) {
      // Blocked answers already rejected in streamCall; anything else but `stop` is an unfinished answer.
      if (end.finish !== "stop") return finish({ kind: "unfinished", message: unfinished(end.finish, end.providerReason) });
      return finish({ kind: "done", text });
    }
    const stop = o.beforeCalls?.(calls, state);
    if (stop) return finish({ kind: "stopped", stop, unrun: calls });

    state.rounds++;
    state.calls += calls.length;
    o.messages.push(end.message);
    const results = await Promise.all(calls.map((c) => o.callTool(c)));
    for (const [i, c] of calls.entries()) o.messages.push({ role: "tool", callId: c.callId, name: c.name, result: results[i] });
  }
}
