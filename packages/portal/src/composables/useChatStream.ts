/**
 * Sends one chat message to `POST /api/chat` and exposes the streaming turn: thought summaries,
 * answer text as it arrives, and tool calls as they start and settle. Behaviour follows the
 * portal-chat spec. The stored thread is the source of truth once the turn ends.
 */
import { ref } from "vue";
import { SseParser } from "../lib/sse.js";

export type LiveItem =
  | { id: number; kind: "thinking"; text: string }
  | { id: number; kind: "text"; text: string }
  /** `callId` is the server's number for the call within the turn; results are matched on it. */
  | { id: number; kind: "tool"; callId: number; name: string; args: unknown; result?: unknown; settled: boolean; at: string };

export interface LiveTurn {
  text: string;
  items: LiveItem[];
  error: string | null;
  running: boolean;
}

export interface SendResult {
  /** The conversation the turn ran in; absent when the server refused the message before storing it. */
  conversationId?: string;
  ok: boolean;
}

export function useChatStream() {
  const turn = ref<LiveTurn | null>(null);
  let seq = 0;

  /** `onStart` runs as soon as the server names the conversation (a new thread gets its id here). */
  async function send(text: string, conversationId: string | undefined, onStart?: (id: string) => void): Promise<SendResult> {
    turn.value = { text, items: [], error: null, running: true };
    // Work on the reactive proxy Vue stored, so every change re-renders.
    const t = turn.value;
    const last = () => t.items[t.items.length - 1];
    const append = (kind: "thinking" | "text", s: string) => {
      const l = last();
      if (l && l.kind === kind) l.text += s;
      else t.items.push({ id: ++seq, kind, text: s });
    };
    /** Set once the server started the turn (and stored the message). */
    let id: string | undefined;
    let ok = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(conversationId ? { text, conversationId } : { text }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => undefined);
        throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        for (const e of parser.push(decoder.decode(r.value, { stream: true }))) {
          const data = JSON.parse(e.data);
          switch (e.event) {
            case "start":
              id = data.conversationId;
              onStart?.(data.conversationId);
              break;
            case "thinking":
              append("thinking", data.text);
              break;
            case "text":
              append("text", data.text);
              break;
            case "tool_call":
              t.items.push({ id: ++seq, kind: "tool", callId: data.id, name: data.name, args: data.args, settled: false, at: new Date().toISOString() });
              break;
            case "tool_result": {
              // Parallel calls settle in any order, so match on the call id, not the name.
              const call = t.items.find((i): i is Extract<LiveItem, { kind: "tool" }> => i.kind === "tool" && i.callId === data.id);
              if (call) Object.assign(call, { result: data.result, settled: true });
              break;
            }
            case "done":
              ok = true;
              break;
            case "error":
              t.error = data.message ?? data.kind;
              break;
          }
        }
      }
      if (!ok && !t.error) t.error = "the connection closed before the answer finished";
    } catch (e) {
      t.error = e instanceof Error ? e.message : String(e);
    } finally {
      t.running = false;
    }
    return { conversationId: id, ok };
  }

  return { turn, send };
}
