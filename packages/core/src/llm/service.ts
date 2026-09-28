/**
 * `ctx.llm` for in-process modules: wraps a TextModel with one FIFO concurrency bound across all
 * modules, a per-attempt timeout, retries for transient errors, the error mapping, schema
 * validation (SDK helpers, shared with the test host), and one content-free log line per call.
 */
import { checkRequest, LlmError, parseOutput, type LlmRequest, type LlmResult, type LlmUsage, type ModuleLlm } from "@friday/sdk";
import type { TextModel, TextResponse } from "./gemini.js";

export interface LlmServiceOptions {
  model: TextModel;
  /** Model names per tier. */
  models: { standard: string; fast: string };
  concurrency: number;
  /** Per-attempt limit when the request sets none. */
  timeoutMs: number;
  log?: Pick<Console, "log" | "warn">;
  /** Delays before the 2nd and 3rd attempt, each with ±20% jitter. Tests shorten them. */
  retryDelaysMs?: number[];
}

/** Finish reasons that mean the provider stopped the answer for safety or policy. */
const BLOCKING_FINISH = new Set(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "OTHER", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"]);
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const cancelled = () => new LlmError("cancelled", "text generation was cancelled");

/** Rejects as soon as `signal` aborts, even if `p` ignores it. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const onAbort = () => {
      clearTimeout(t);
      reject(cancelled());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Counter-and-queue semaphore; waiters are served in arrival order and leave the queue when aborted. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly size: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(cancelled());
    const release = () => {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
    if (this.active < this.size) {
      this.active++;
      return Promise.resolve(once(release));
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(once(release));
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(cancelled());
      };
      this.waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (!done) (done = true), fn();
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Maps a provider failure (not ours) to a typed error and whether it is worth another attempt. */
function classify(e: unknown): { error: LlmError; retry: boolean } {
  if (e instanceof LlmError) return { error: e, retry: false };
  const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : undefined;
  if (status === undefined) return { error: new LlmError("unavailable", `model unreachable: ${message(e)}`, { cause: e }), retry: true };
  if (TRANSIENT_STATUS.has(status)) return { error: new LlmError("unavailable", `model unavailable (HTTP ${status})`, { cause: e }), retry: true };
  if (status === 400 || status === 404) return { error: new LlmError("invalid_request", `model rejected the request (HTTP ${status}): ${message(e)}`, { cause: e }), retry: false };
  return { error: new LlmError("unavailable", `model call failed (HTTP ${status}): ${message(e)}`, { cause: e }), retry: false };
}

export class LlmService {
  private readonly slots: Semaphore;
  private readonly log: Pick<Console, "log" | "warn">;
  private readonly delays: number[];

  constructor(private readonly opts: LlmServiceOptions) {
    this.slots = new Semaphore(Math.max(1, opts.concurrency));
    this.log = opts.log ?? console;
    this.delays = opts.retryDelaysMs ?? [1000, 4000];
  }

  /** The `ctx.llm` facade for one module; its calls are logged under `owner`. */
  forOwner(owner: string): ModuleLlm {
    return { generate: <T>(req: LlmRequest) => this.generate<T>(owner, req) };
  }

  async generate<T = unknown>(owner: string, req: LlmRequest): Promise<LlmResult<T>> {
    const started = Date.now();
    const model = req?.model === "fast" ? this.opts.models.fast : this.opts.models.standard;
    let attempts = 0;
    let res: TextResponse | undefined;
    try {
      checkRequest(req);
      const release = await this.slots.acquire(req.signal);
      try {
        for (;;) {
          attempts++;
          try {
            res = await this.attempt(model, req);
            break;
          } catch (e) {
            const { error, retry } = classify(e);
            if (!retry || attempts > this.delays.length) throw error;
            const d = this.delays[attempts - 1];
            await sleep(d * (0.8 + Math.random() * 0.4), req.signal);
          }
        }
      } finally {
        release();
      }
      const reason = res.blockReason ?? (res.finishReason && BLOCKING_FINISH.has(res.finishReason) ? res.finishReason : undefined);
      if (reason) throw new LlmError("blocked", `the model provider blocked the ${res.blockReason ? "prompt" : "response"} (${reason})`, { reason });
      const usage: LlmUsage = res.usage;
      const out: LlmResult<T> = { text: res.text, model, usage };
      if (req.schema) out.json = parseOutput<T>(req.schema, res.text, res.finishReason);
      this.record(owner, model, res, started, attempts, "ok");
      return out;
    } catch (e) {
      const error = e instanceof LlmError ? e : new LlmError("unavailable", message(e), { cause: e });
      this.record(owner, model, res, started, attempts, error);
      throw error;
    }
  }

  /** One provider call bounded by the caller's signal and the per-attempt timeout. */
  private async attempt(model: string, req: LlmRequest): Promise<TextResponse> {
    const ms = req.timeoutMs ?? this.opts.timeoutMs;
    const timeout = AbortSignal.timeout(ms);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const { system, prompt, messages, schema, temperature, maxOutputTokens } = req;
    try {
      return await raceAbort(this.opts.model.generate({ model, system, prompt, messages, schema, temperature, maxOutputTokens }, { signal }), signal);
    } catch (e) {
      if (req.signal?.aborted) throw cancelled();
      if (timeout.aborted) throw new LlmError("unavailable", `timed out after ${ms} ms`);
      throw e;
    }
  }

  /** One line per settled call. Never includes prompts, messages or output. */
  private record(owner: string, model: string, res: TextResponse | undefined, started: number, attempts: number, outcome: "ok" | LlmError): void {
    const u = res?.usage;
    const version = res && res.model !== model ? ` (${res.model})` : "";
    const tokens = u ? ` in=${u.inputTokens} out=${u.outputTokens}${u.thoughtTokens ? ` think=${u.thoughtTokens}` : ""}` : "";
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const tries = `(${attempts} attempt${attempts === 1 ? "" : "s"})`;
    if (outcome === "ok") return this.log.log(`llm: [${owner}] ${model}${version} ok${tokens} ${secs}s ${tries}`);
    // Error messages are ours or the provider's status text; invalid_output's `raw` is never logged.
    const detail = outcome.kind === "cancelled" ? "" : `: ${outcome.message.slice(0, 200)}`;
    this.log.warn(`llm: [${owner}] ${model}${version} ${outcome.kind}${detail}${tokens} ${secs}s ${tries}`);
  }
}
