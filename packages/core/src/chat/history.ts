/**
 * A chat thread's stored entries as Gemini `contents`, replayed in full on every turn.
 *
 * - user entries become user text, assistant entries model text (interrupted ones as stored);
 * - a tool entry becomes a `functionCall` in the model's turn and its `functionResponse` in the user
 *   turn right after it. The store can't tell parallel calls from sequential rounds, so every call is
 *   replayed with its own response: a later call never appears to precede an earlier result;
 * - past calls carry no thought signature (we don't store them). Gemini accepts that for earlier
 *   turns (see the spike in the portal-chat design); calls within the running turn are sent verbatim
 *   by the engine instead;
 * - a result cut by the store is `{ truncated: true, partial }`, and a missing one `{ error: "no result" }`.
 * Adjacent contents of the same role and kind are merged into one.
 */
import type { Content, Part } from "@google/genai";
import type { ConversationEntry } from "@friday/sdk";
import type { ChatMessage } from "../llm/types.js";

type Kind = "text" | "calls" | "responses";

export function toContents(entries: ConversationEntry[]): Content[] {
  const out: { kind: Kind; content: Content }[] = [];
  const push = (role: "user" | "model", kind: Kind, part: Part) => {
    const last = out.at(-1);
    // A model turn holds its text and the call after it; user text and function responses stay apart.
    const joins = last && last.content.role === role && (role === "model" || last.kind === kind);
    if (joins) last.content.parts!.push(part);
    else out.push({ kind, content: { role, parts: [part] } });
  };

  for (const e of entries) {
    if (e.kind === "tool") {
      push("model", "calls", { functionCall: { name: e.name, args: toArgs(e.args, e.truncated) } });
      push("user", "responses", { functionResponse: { name: e.name, response: toResponse(e.result, e.truncated) } });
    } else if (e.kind === "user") push("user", "text", { text: e.text });
    else push("model", "text", { text: e.text });
  }
  return out.map((o) => o.content);
}

/**
 * A chat thread's stored entries as provider-neutral messages: user entries as user text, assistant entries
 * as assistant text (interrupted ones as stored), and each tool entry as an assistant message with one call
 * followed by its tool message. Stored calls have no id, so each gets `h<seq>` from its entry. Merging
 * adjacent turns is the adapter's business (Gemini merges, OpenAI-compatible servers don't need to).
 */
export function toMessages(entries: ConversationEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of entries) {
    if (e.kind === "tool") {
      const id = `h${e.seq}`;
      out.push({ role: "assistant", toolCalls: [{ id, name: e.name, args: toArgs(e.args, e.truncated) }] });
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
