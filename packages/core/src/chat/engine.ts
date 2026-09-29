/**
 * Portal chat: one turn per message against the text model, over the thread's whole stored history.
 *
 * `begin` validates synchronously (so two posts for one thread can't both pass the busy check), then
 * stores the message and returns the turn; `run` streams it:
 *   history (+ the new message) -> model round -> tool calls (chat channel, timed out) -> next round ...
 * until the model answers without calls, at most MAX_TOOL_ROUNDS rounds of calls. Within the turn
 * the model's parts go back verbatim (thought signatures kept, thought summaries dropped). The turn
 * never depends on its listener: a disconnected client only stops receiving events.
 */
import type { Content, FunctionDeclaration, Part } from "@google/genai";
import { LlmError, type ToolRegistry } from "@friday/sdk";
import type { ConversationRecorder } from "../conversations/recorder.js";
import type { ConversationStore } from "../conversations/store.js";
import type { StreamEnd } from "../llm/gemini.js";
import type { LlmService } from "../llm/service.js";
import { toContents } from "./history.js";

export const MAX_TOOL_ROUNDS = 10;

interface Call {
  id: number;
  name: string;
  args: Record<string, unknown>;
}

/** Why a round without calls ended before its answer was complete. */
function unfinished(reason: string): string {
  if (reason === "MAX_TOKENS") return "the answer was cut off at the output limit";
  if (reason === "MALFORMED_FUNCTION_CALL") return "the model produced a malformed tool call";
  return `the model stopped without finishing (${reason})`;
}

export type ChatErrorKind = LlmError["kind"] | "too_many_tool_calls";

export type ChatEvent =
  | { event: "start"; data: { conversationId: string } }
  | { event: "thinking"; data: { text: string } }
  | { event: "text"; data: { text: string } }
  /** `id` numbers the turn's calls from 1, so a result can be matched to its call (results arrive as they settle). */
  | { event: "tool_call"; data: { id: number; name: string; args: Record<string, unknown> } }
  | { event: "tool_result"; data: { id: number; name: string; result: unknown } }
  | { event: "done"; data: { conversationId: string } }
  | { event: "error"; data: { kind: ChatErrorKind; message: string } };

export interface ChatEngineOptions {
  store: ConversationStore;
  registry: ToolRegistry;
  llm: Pick<LlmService, "streamCall">;
  /** The chat model (FRIDAY_CHAT_MODEL, falling back to the text model). */
  model: string;
  /**
   * The chat system prompt (shared base, chat part, module context). Built once when a turn starts
   * and used for every model call of that turn.
   */
  system: () => string;
  /** A tool call that has not settled after this long is answered with a timeout error. */
  toolTimeoutMs: number;
  log?: Pick<Console, "log" | "warn" | "error">;
}

export interface ChatMessage {
  text?: unknown;
  conversationId?: unknown;
}

export type BeginResult =
  | { ok: true; turn: ChatTurn }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string };

export class ChatEngine {
  private readonly log: Pick<Console, "log" | "warn" | "error">;

  constructor(private readonly opts: ChatEngineOptions) {
    this.log = opts.log ?? console;
  }

  /** Validate and store the message. Synchronous up to the stored user entry, so the busy check can't race. */
  begin(msg: ChatMessage): BeginResult {
    const text = typeof msg?.text === "string" ? msg.text.trim() : "";
    if (!text) return { ok: false, status: 400, error: "text is required" };
    const id = msg.conversationId;
    if (id !== undefined && id !== null && typeof id !== "string") return { ok: false, status: 400, error: "conversationId must be a string" };
    const { store } = this.opts;
    if (id) {
      if (store.channelOf(id) !== "chat") return { ok: false, status: 404, error: "unknown chat conversation" };
      if (store.isLive(id)) return { ok: false, status: 409, error: "a turn is still running in this conversation" };
    }
    const recorder = store.recorder({ channel: "chat" }, this.log);
    if (id && !recorder.resume(id)) return { ok: false, status: 404, error: "unknown chat conversation" };
    // The recorder logs and swallows store failures; the turn must not run without its message.
    const before = id ? this.nextSeq(id) : undefined;
    recorder.user(text, "text");
    recorder.commitUser();
    const conversationId = recorder.conversationId;
    const stored = conversationId !== undefined && (!id || (before !== undefined && this.nextSeq(conversationId) === before + 1));
    if (!conversationId || !stored) {
      recorder.release();
      return { ok: false, status: 503, error: "the message could not be stored" };
    }
    return { ok: true, turn: new ChatTurn(this.opts, this.log, recorder, conversationId, text) };
  }

  private nextSeq(id: string): number | undefined {
    try {
      return this.opts.store.nextSeq(id);
    } catch {
      return undefined;
    }
  }
}

export class ChatTurn {
  constructor(
    private readonly opts: ChatEngineOptions,
    private readonly log: Pick<Console, "log" | "warn" | "error">,
    private readonly recorder: ConversationRecorder,
    readonly conversationId: string,
    private readonly text: string,
  ) {}

  /** Stream the turn to `listener`; resolves once it is recorded. Never rejects. */
  async run(listener: (e: ChatEvent) => void): Promise<void> {
    const emit = (e: ChatEvent) => {
      try {
        listener(e);
      } catch (err) {
        this.log.warn("chat: listener failed", err instanceof Error ? err.message : err);
      }
    };
    const id = this.conversationId;
    emit({ event: "start", data: { conversationId: id } });
    try {
      const system = this.opts.system();
      const contents = this.history();
      const tools = this.opts.registry.declarations("chat") as FunctionDeclaration[];
      let rounds = 0;
      let streamed = false;
      let callSeq = 0;
      for (;;) {
        const parts: Part[] = [];
        const calls: Call[] = [];
        let end: StreamEnd;
        try {
          end = await this.opts.llm.streamCall(
            "chat",
            { model: this.opts.model, system, contents, tools, thoughts: true },
            (c) => {
              if (c.kind === "thought") return emit({ event: "thinking", data: { text: c.text } });
              parts.push(c.part);
              if (c.kind === "text") {
                streamed = true;
                this.recorder.assistant(c.text);
                emit({ event: "text", data: { text: c.text } });
              } else if (c.kind === "call") {
                const call = { id: ++callSeq, name: c.name, args: c.args };
                calls.push(call);
                emit({ event: "tool_call", data: call });
              }
            },
          );
        } catch (e) {
          const err = e instanceof LlmError ? e : new LlmError("unavailable", e instanceof Error ? e.message : String(e));
          if (streamed) this.recorder.interrupted();
          return this.fail(emit, err.kind, err.message);
        }
        if (!calls.length) {
          // Blocked answers already rejected in streamCall; anything else but STOP is an unfinished answer.
          const reason = end.finishReason;
          if (reason && reason !== "STOP") {
            if (streamed) this.recorder.interrupted();
            return this.fail(emit, "invalid_output", unfinished(reason));
          }
          break;
        }
        if (rounds >= MAX_TOOL_ROUNDS) {
          // These calls were announced but never run: settle them, so live and stored views agree.
          for (const c of calls) this.settleUnrun(c, emit);
          return this.fail(emit, "too_many_tool_calls", `the model asked for tools more than ${MAX_TOOL_ROUNDS} times in one turn`);
        }
        rounds++;
        contents.push({ role: "model", parts });
        const results = await Promise.all(calls.map((c) => this.callTool(c, emit)));
        contents.push({ role: "user", parts: calls.map((c, i) => ({ functionResponse: { name: c.name, response: results[i] } })) });
      }
      this.recorder.release();
      emit({ event: "done", data: { conversationId: id } });
    } catch (e) {
      // Our own bug, not the model's: still record what we have and end the stream.
      this.log.error(`chat: turn in ${id} failed`, e);
      this.fail(emit, "unavailable", e instanceof Error ? e.message : String(e));
    }
  }

  /** The stored thread, which already ends with this turn's message. */
  private history(): Content[] {
    try {
      const c = this.opts.store.get(this.conversationId);
      if (c) return toContents(c.entries);
    } catch (e) {
      this.log.error(`chat: could not read ${this.conversationId}`, e instanceof Error ? e.message : e);
    }
    return [{ role: "user", parts: [{ text: this.text }] }];
  }

  private settleUnrun({ id, name, args }: Call, emit: (e: ChatEvent) => void): void {
    const result = { error: `not run: more than ${MAX_TOOL_ROUNDS} rounds of tool calls` };
    this.recorder.tool(name, args).result(result);
    emit({ event: "tool_result", data: { id, name, result } });
  }

  private async callTool({ id, name, args }: Call, emit: (e: ChatEvent) => void): Promise<Record<string, unknown>> {
    const handle = this.recorder.tool(name, args);
    const ms = this.opts.toolTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms)));
    const call = this.opts.registry.callTool(name, args, { channel: "chat" });
    const outcome = await Promise.race([call, timedOut]);
    clearTimeout(timer);
    let result: Record<string, unknown>;
    if (outcome === "timeout") {
      result = { error: `timed out after ${ms} ms` };
      void call.then(() => this.log.warn(`chat: tool ${name} settled after its ${ms} ms timeout; result dropped`));
    } else {
      // Scheduling hints and endConversation requests mean nothing in chat.
      result = outcome.result;
    }
    handle.result(result);
    emit({ event: "tool_result", data: { id, name, result } });
    return result;
  }

  private fail(emit: (e: ChatEvent) => void, kind: ChatErrorKind, message: string): void {
    this.recorder.release();
    emit({ event: "error", data: { kind, message } });
  }
}
