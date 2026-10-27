/**
 * Portal chat: one turn per message against the text model, over the thread's whole stored history.
 *
 * `begin` validates synchronously (so two posts for one thread can't both pass the busy check), then
 * stores the message and returns the turn; `run` streams it:
 *   history (+ the new message) -> model round -> tool calls (chat channel, timed out) -> next round ...
 * until the model answers without calls, at most MAX_TOOL_ROUNDS rounds of calls (the loop itself is
 * shared with agent runs, llm/tool-loop.ts). The turn never depends on its listener: a disconnected
 * client only stops receiving events.
 */
import type { Content, FunctionDeclaration } from "@google/genai";
import { LlmError, type CallUser, type ToolRegistry } from "@friday/sdk";
import type { ConversationRecorder } from "../conversations/recorder.js";
import type { ConversationStore } from "../conversations/store.js";
import type { LlmService } from "../llm/service.js";
import { runToolLoop, type LoopCall as Call } from "../llm/tool-loop.js";
import { toContents } from "./history.js";

export const MAX_TOOL_ROUNDS = 10;

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
   * The chat system prompt (shared base, chat part, module context for the turn's user). Built once when a turn
   * starts and used for every model call of that turn.
   */
  system: (user?: CallUser) => string;
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

  /**
   * Validate and store the message of `user`. Synchronous up to the stored user entry, so the busy check can't
   * race. The turn's prompt and tool calls are for that user.
   */
  begin(msg: ChatMessage, user?: CallUser): BeginResult {
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
    return { ok: true, turn: new ChatTurn(this.opts, this.log, recorder, conversationId, text, user && { id: user.id, name: user.name }) };
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
    private readonly user?: CallUser,
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
      const { outcome, state } = await runToolLoop({
        llm: this.opts.llm,
        owner: "chat",
        model: this.opts.model,
        system: this.opts.system(this.user),
        contents: this.history(),
        tools: this.opts.registry.declarations("chat") as FunctionDeclaration[],
        thoughts: true,
        onThought: (text) => emit({ event: "thinking", data: { text } }),
        onText: (text) => {
          this.recorder.assistant(text);
          emit({ event: "text", data: { text } });
        },
        onCall: (call) => emit({ event: "tool_call", data: call }),
        callTool: (c) => this.callTool(c, emit),
        beforeCalls: (_calls, s) =>
          s.rounds >= MAX_TOOL_ROUNDS ? { kind: "too_many_tool_calls", message: `the model asked for tools more than ${MAX_TOOL_ROUNDS} times in one turn` } : undefined,
      });
      if (outcome.kind === "stopped") {
        // These calls were announced but never run: settle them, so live and stored views agree.
        for (const c of outcome.unrun) this.settleUnrun(c, emit);
        return this.fail(emit, "too_many_tool_calls", outcome.stop.message);
      }
      if (outcome.kind !== "done") {
        if (state.streamed) this.recorder.interrupted();
        if (outcome.kind === "unfinished") return this.fail(emit, "invalid_output", outcome.message);
        const err = outcome.kind === "failed" ? outcome.error : new LlmError("cancelled", "the turn was cancelled");
        return this.fail(emit, err.kind, err.message);
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
    const call = this.opts.registry.callTool(name, args, { channel: "chat", conversationId: this.conversationId, user: this.user });
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
