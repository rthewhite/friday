/**
 * A chat thread's stored entries as provider-neutral messages, replayed in full on every turn.
 *
 * - user entries become user text, assistant entries assistant text (interrupted ones as stored);
 * - a tool entry becomes an assistant message with one call (joining the assistant's text right before
 *   it, as one turn), followed by its tool message. The store
 *   can't tell parallel calls from sequential rounds, so every call is replayed with its own result: a
 *   later call never appears to precede an earlier result. Stored calls have no id, so each gets
 *   `h<seq>` from its entry;
 * - past calls carry no provider data such as Gemini's thought signatures (we don't store them). Gemini
 *   accepts that for earlier turns (see the spike in the portal-chat design); calls within the running
 *   turn go back as the adapter returned them;
 * - a result cut by the store is `{ truncated: true, partial }`, and a missing one `{ error: "no result" }`.
 * Merging adjacent turns is the adapter's business (Gemini merges, OpenAI-compatible servers don't need to).
 */
import type { ConversationEntry } from "@friday/sdk";
import type { ChatMessage } from "../llm/types.js";

export function toMessages(entries: ConversationEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of entries) {
    if (e.kind === "tool") {
      const id = `h${e.seq}`;
      const call = { id, name: e.name, args: toArgs(e.args, e.truncated) };
      // An assistant's text and the call right after it are one turn, so roles keep alternating
      // (some chat templates refuse two assistant messages in a row).
      const last = out.at(-1);
      if (last?.role === "assistant" && !last.toolCalls) last.toolCalls = [call];
      else out.push({ role: "assistant", toolCalls: [call] });
      out.push({ role: "tool", callId: id, name: e.name, result: toResponse(e.result, e.truncated) });
    } else if (e.kind === "user") out.push({ role: "user", text: e.text });
    else out.push({ role: "assistant", text: e.text });
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The store gives back the cut text (a string) when truncation left invalid JSON. */
function toArgs(args: unknown, truncated: boolean): Record<string, unknown> {
  if (isObject(args)) return args;
  if (truncated && typeof args === "string") return { truncated: true, partial: args };
  return args === null || args === undefined ? {} : { value: args };
}

function toResponse(result: unknown, truncated: boolean): Record<string, unknown> {
  if (result === undefined) return { error: "no result" };
  if (truncated && typeof result === "string") return { truncated: true, partial: result };
  return isObject(result) ? result : { result };
}
