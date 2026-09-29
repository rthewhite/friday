/**
 * Prompt context: modules add text to Friday's system prompt through synchronous providers.
 * Rendering is shared by core (every module, in load order) and the test host (one module).
 */
import type { ConversationChannel } from "./conversations.js";
import type { ModuleLogger } from "./module.js";

export interface PromptContextInfo {
  /** The prompt being built: `voice` when a Live session opens, `chat` when a chat turn starts. */
  channel: ConversationChannel;
}

/**
 * Returns text to append to the system prompt, or `undefined` for none. Called every time a prompt is
 * built, on the path that opens a voice session, so it must be synchronous and fast (read local state only).
 */
export type PromptContextProvider = (info: PromptContextInfo) => string | undefined;

export interface ModulePrompt {
  /** Registers a provider. Returns a function that removes it. The host also removes it on dispose, reload or failure. */
  addContext(provider: PromptContextProvider): () => void;
}

/** A module's combined context is cut to this many characters unless the host configures otherwise. */
export const DEFAULT_PROMPT_CONTEXT_MAX_CHARS = 12000;
/** Providers slower than this are logged with their duration. */
export const SLOW_PROVIDER_MS = 100;

export interface PromptContextOptions {
  /** Per-module cap on the rendered context (default 12000). */
  maxChars?: number;
  log?: ModuleLogger;
  /** Clock for timing providers (tests inject one). */
  now?: () => number;
}

/** Providers per module, rendered in the order modules first got a slot (load order), then registration order. */
export class PromptContext {
  private readonly owners = new Map<string, { fn: PromptContextProvider }[]>();
  private readonly maxChars: number;
  private readonly log: ModuleLogger;
  private readonly now: () => number;

  constructor(opts: PromptContextOptions = {}) {
    this.maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_PROMPT_CONTEXT_MAX_CHARS));
    this.log = opts.log ?? console;
    this.now = opts.now ?? (() => performance.now());
  }

  /** The `ctx.prompt` of one module. Reserves the module's place in the render order on first call. */
  forOwner(owner: string): ModulePrompt {
    if (!this.owners.has(owner)) this.owners.set(owner, []);
    return {
      addContext: (fn) => {
        if (typeof fn !== "function") throw new Error(`${owner}: addContext needs a function`);
        const entry = { fn };
        const list = this.owners.get(owner) ?? [];
        this.owners.set(owner, [...list, entry]);
        return () => {
          const current = this.owners.get(owner);
          if (current) this.owners.set(owner, current.filter((e) => e !== entry));
        };
      },
    };
  }

  /** Removes a module's providers; the module keeps its place in the render order. */
  clear(owner: string): void {
    if (this.owners.has(owner)) this.owners.set(owner, []);
  }

  /** Module context for `channel`: each module's non-empty output, capped, separated by blank lines. */
  render(channel: ConversationChannel): string {
    const blocks: string[] = [];
    for (const [owner, providers] of this.owners) {
      const parts: string[] = [];
      for (const { fn } of providers) {
        const out = this.call(owner, fn, channel);
        if (out) parts.push(out);
      }
      if (!parts.length) continue;
      let text = parts.join("\n\n");
      if (text.length > this.maxChars) {
        this.log.warn(`prompt context from ${owner} is ${text.length} characters; cut to ${this.maxChars}`);
        text = `${text.slice(0, this.maxChars - 1)}…`;
      }
      blocks.push(text);
    }
    return blocks.join("\n\n");
  }

  private call(owner: string, fn: PromptContextProvider, channel: ConversationChannel): string | undefined {
    const started = this.now();
    try {
      const out: unknown = fn({ channel });
      if (typeof (out as PromiseLike<unknown> | undefined)?.then === "function") {
        void Promise.resolve(out).catch(() => {});
        this.log.warn(`prompt context provider of ${owner} returned a promise and was skipped; providers must be synchronous`);
        return undefined;
      }
      return typeof out === "string" ? out.trim() || undefined : undefined;
    } catch (e) {
      this.log.error(`prompt context provider of ${owner} failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    } finally {
      const ms = this.now() - started;
      if (ms > SLOW_PROVIDER_MS) this.log.warn(`prompt context provider of ${owner} took ${Math.round(ms)} ms`);
    }
  }
}

/** A channel prompt followed by the module context, when there is any. */
export const composePrompt = (prompt: string, context: string): string => (context ? `${prompt}\n\n${context}` : prompt);
