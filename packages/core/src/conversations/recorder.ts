/**
 * Records one live conversation into the store. Engine-agnostic: GeminiSession drives it on
 * /ws/audio, a chat engine can drive it directly (with `resume` to append to a thread).
 *
 * Turn assembly: the recorder holds the current exchange (user segments, then assistant text and
 * tool calls in order) and writes it as whole entries when the exchange settles:
 * - user fragments before any output join the user buffer (speech fragments merge; each typed text is its own entry);
 * - assistant fragments join until a tool call, which ends that assistant entry and takes its place after it;
 * - user fragments that arrive during output are held as pending. On `interrupted` the assistant entry is
 *   marked interrupted and pending starts the next exchange (a barge-in). On `turnComplete` pending speech
 *   belongs to this exchange's question (a late fragment) and pending typed text starts the next one;
 * - a tool entry is written once it has its result, or at `end()` without one.
 * Every store call is caught and logged: recording never throws into the session.
 */
import type { ConversationInput } from "@friday/sdk";
import type { ConversationMeta, ConversationStore, NewEntry } from "./store.js";

export type RecorderLog = Pick<Console, "error">;

export interface ToolHandle {
  /** Call once the tool settled; concurrent calls to the same tool each have their own handle. */
  result(result: unknown): void;
}

interface Segment {
  input: ConversationInput;
  text: string;
  at: string;
}

interface AssistantItem {
  kind: "assistant";
  text: string;
  at: string;
  interrupted: boolean;
}

interface ToolItem {
  kind: "tool";
  name: string;
  args: unknown;
  at: string;
  settled: boolean;
  result?: unknown;
  seq?: number;
  written: boolean;
}

const noop: ToolHandle = { result() {} };

export class ConversationRecorder {
  private id?: string;
  private seq = 0;
  private ended = false;
  private question: Segment[] = [];
  private body: (AssistantItem | ToolItem)[] = [];
  private pending: Segment[] = [];
  private outputStarted = false;
  /** Tools already placed in the transcript that are still waiting for their result. */
  private readonly awaiting = new Set<ToolItem>();

  constructor(private readonly store: ConversationStore, private readonly meta: ConversationMeta, private readonly log: RecorderLog = console) {}

  /** The stored conversation's id, once its first entry exists (or after `resume`). */
  get conversationId(): string | undefined {
    return this.id;
  }

  user(text: string, input: ConversationInput): void {
    if (this.ended || !text) return;
    this.guard("user", () => pushSegment(this.outputStarted ? this.pending : this.question, input, text, this.now()));
  }

  assistant(text: string): void {
    if (this.ended || !text) return;
    this.guard("assistant", () => {
      this.outputStarted = true;
      const last = this.body.at(-1);
      if (last?.kind === "assistant") last.text += text;
      else this.body.push({ kind: "assistant", text, at: this.now(), interrupted: false });
    });
  }

  tool(name: string, args: unknown): ToolHandle {
    if (this.ended) return noop;
    try {
      this.outputStarted = true;
      const item: ToolItem = { kind: "tool", name, args, at: this.now(), settled: false, written: false };
      this.body.push(item);
      return { result: (r) => this.guard("tool result", () => this.settle(item, r)) };
    } catch (e) {
      this.fail("tool", e);
      return noop;
    }
  }

  interrupted(): void {
    if (this.ended || !this.outputStarted) return;
    this.guard("interrupted", () => {
      const last = this.body.at(-1);
      if (last?.kind === "assistant") last.interrupted = true;
      const next = this.pending;
      this.pending = [];
      this.flush();
      this.question = next;
    });
  }

  turnComplete(): void {
    if (this.ended || !this.outputStarted) return;
    this.guard("turn complete", () => this.complete());
  }

  /** Write everything held, then mark the conversation quiet with the reason. Later calls are ignored. */
  end(reason?: string): void {
    if (this.ended) return;
    this.guard("end", () => {
      if (this.outputStarted) this.complete();
      this.flush();
      for (const t of this.awaiting) this.writeTool(t);
      this.awaiting.clear();
    });
    this.ended = true;
    if (!this.id) return;
    const id = this.id;
    this.guard("end", () => void this.store.markQuiet(id, { reason: reason ?? null }));
    this.store.detach(id);
  }

  /** Append to an existing conversation instead of starting a new one. Returns false when it is unknown. */
  resume(id: string): boolean {
    if (this.id || this.ended) return false;
    let next: number | undefined;
    this.guard("resume", () => void (next = this.store.nextSeq(id)), id);
    if (next === undefined) return false;
    this.id = id;
    this.seq = next - 1;
    this.store.attach(id);
    return true;
  }

  private now(): string {
    return this.store.now().toISOString();
  }

  /** Settle the exchange without an interruption: pending speech completes the question, pending text starts the next one. */
  private complete(): void {
    const firstText = this.pending.findIndex((s) => s.input === "text");
    const late = firstText < 0 ? this.pending : this.pending.slice(0, firstText);
    const next = firstText < 0 ? [] : this.pending.slice(firstText);
    for (const s of late) pushSegment(this.question, s.input, s.text, s.at);
    this.pending = [];
    this.flush();
    this.question = next;
  }

  /** Write the exchange in order and start a new one. */
  private flush(): void {
    // A new conversation starts when its exchange started, not when it is first written.
    const started = [...this.question, ...this.body].map((x) => x.at).sort()[0];
    for (const s of this.question) {
      const text = s.text.trim();
      if (text) this.write({ kind: "user", at: s.at, input: s.input, text }, started);
    }
    for (const item of this.body) {
      if (item.kind === "assistant") {
        const text = item.text.trim();
        if (text) this.write({ kind: "assistant", at: item.at, text, interrupted: item.interrupted }, started);
        continue;
      }
      item.seq = this.reserve(started);
      if (item.seq === undefined) continue;
      if (item.settled) this.writeTool(item);
      else this.awaiting.add(item);
    }
    this.question = [];
    this.body = [];
    this.outputStarted = false;
  }

  private settle(item: ToolItem, result: unknown): void {
    if (item.settled) return;
    item.settled = true;
    item.result = result;
    if (item.seq !== undefined && !item.written) {
      this.awaiting.delete(item);
      this.writeTool(item);
    }
  }

  private writeTool(item: ToolItem): void {
    item.written = true;
    this.append(item.seq!, { kind: "tool", at: item.at, name: item.name, args: item.args, result: item.settled ? item.result : undefined });
  }

  private write(e: NewEntry, started?: string): void {
    const seq = this.reserve(started);
    if (seq !== undefined) this.append(seq, e);
  }

  /** Next position; creates the conversation (started at `started`) on its first entry. */
  private reserve(started?: string): number | undefined {
    if (!this.id) {
      try {
        this.id = this.store.create(this.meta, started);
      } catch (e) {
        this.fail("create", e);
        return undefined;
      }
      this.store.attach(this.id);
    }
    return ++this.seq;
  }

  private append(seq: number, e: NewEntry): void {
    const id = this.id!;
    this.guard(`write ${e.kind} entry`, () => this.store.append(id, seq, e));
  }

  private guard(op: string, fn: () => void, id = this.id): void {
    try {
      fn();
    } catch (e) {
      this.fail(op, e, id);
    }
  }

  private fail(op: string, e: unknown, id = this.id): void {
    this.log.error(`conversation ${id ?? "(not created)"}: ${op} failed:`, e instanceof Error ? e.message : e);
  }
}

/** Consecutive speech fragments join (keeping the transcription's own spacing); typed texts stay separate. */
function pushSegment(target: Segment[], input: ConversationInput, text: string, at: string): void {
  const last = target.at(-1);
  if (input === "speech" && last?.input === "speech") last.text += text;
  else target.push({ input, text, at });
}
