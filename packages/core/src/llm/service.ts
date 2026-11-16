/**
 * `ctx.llm` for in-process modules, and the streamed calls of chat and agents: wraps a provider-neutral
 * `ChatModel` with one FIFO concurrency bound across all callers, a per-attempt timeout, retries for
 * transient errors, the error mapping, schema validation (SDK helpers, shared with the test host), and
 * one content-free log line per call. Provider specifics stay in the adapters, which report failures as
 * `ProviderError`.
 */
import { checkRequest, LlmError, parseOutput, type LlmRequest, type LlmResult, type LlmUsage, type ModuleLlm } from "@friday/sdk";
import { BlockedError, messageOf, ProviderError, type ChatMessage, type ChatModel, type ChatRequest, type ModelEnd, type StreamChunk } from "./types.js";

/** A streamed call: the model is already resolved by the caller (the chat model). */
export interface StreamCallRequest extends ChatRequest {
  signal?: AbortSignal;
  /** Per-attempt limit; defaults to the service's. */
  timeoutMs?: number;
  maxRetryWaitMs?: number;
}

export interface LlmServiceOptions {
  model: ChatModel;
  /** Model names per tier. */
  models: { standard: string; fast: string };
  concurrency: number;
  /** Per-attempt limit when the request sets none. */
  timeoutMs: number;
  log?: Pick<Console, "log" | "warn">;
  /** Delays before the 2nd and 3rd attempt, each with ±20% jitter. Tests shorten them. */
  retryDelaysMs?: number[];
  /** Longest wait before retrying after a rate limit when the request sets none (FRIDAY_LLM_MAX_RETRY_WAIT_MS). */
  maxRetryWaitMs?: number;
  /** Waits between attempts; tests replace it to skip real delays. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A blocked answer still names the model that answered and its usage, for the log line. */
const answered = (e: LlmError): Pick<ModelEnd, "model" | "usage"> | undefined => (e instanceof BlockedError ? { model: e.model, usage: e.usage } : undefined);

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

const message = messageOf;

export interface Failure {
  error: LlmError;
  /** Worth another attempt. */
  retry: boolean;
  /** For the log: the HTTP status, or `network`. Absent for our own errors (timeouts, missing key). */
  reason?: string;
  /** The wait a rate limit asks for, in ms. */
  waitMs?: number;
  /** The exhausted quota a rate limit names; `daily` when it is a per-day quota. */
  quota?: string;
  daily?: boolean;
}

/**
 * Maps a failure to a typed error and whether it is worth another attempt. Adapters report provider
 * failures as `ProviderError`; our own errors (`LlmError`) pass through; anything else is taken for an
 * unreachable model.
 */
export function classify(e: unknown): Failure {
  if (e instanceof LlmError) return { error: e, retry: false };
  if (!(e instanceof ProviderError)) return { error: new LlmError("unavailable", `model unreachable: ${message(e)}`, { cause: e }), retry: true, reason: "network" };
  const { reason } = e;
  // Most reasons are HTTP statuses; an adapter's own ones (`stream`, `response`) are named as they are.
  const where = /^\d+$/.test(reason) ? `HTTP ${reason}` : reason;
  switch (e.kind) {
    case "rate_limited":
      return {
        error: new LlmError("unavailable", `model rate-limited (${where})`, { cause: e }),
        retry: true,
        reason,
        ...(e.waitMs !== undefined ? { waitMs: e.waitMs } : {}),
        ...(e.quota !== undefined ? { quota: e.quota } : {}),
        ...(e.daily ? { daily: true } : {}),
      };
    case "transient":
      return { error: new LlmError("unavailable", reason === "network" ? `model unreachable: ${e.message}` : `model unavailable (${where})`, { cause: e }), retry: true, reason };
    case "invalid_request":
      return { error: new LlmError("invalid_request", `model rejected the request (${where}): ${e.message}`, { cause: e }), retry: false, reason };
    default:
      return { error: new LlmError("unavailable", `model call failed (${where}): ${e.message}`, { cause: e }), retry: false, reason };
  }
}

/** One failed attempt as the log line shows it: `429 wait 37s`, `503`, `network wait 1.1s`. */
interface FailedAttempt {
  reason: string;
  waitMs?: number;
}

const seconds = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

export class LlmService {
  private readonly slots: Semaphore;
  private readonly log: Pick<Console, "log" | "warn">;
  private readonly delays: number[];
  private readonly maxRetryWaitMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly opts: LlmServiceOptions) {
    this.slots = new Semaphore(Math.max(1, opts.concurrency));
    this.log = opts.log ?? console;
    this.delays = opts.retryDelaysMs ?? [1000, 4000];
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 60_000;
    this.sleep = opts.sleep ?? sleep;
  }

  /** The `ctx.llm` facade for one module; its calls are logged under `owner`. */
  forOwner(owner: string): ModuleLlm {
    return { generate: <T>(req: LlmRequest) => this.generate<T>(owner, req) };
  }

  async generate<T = unknown>(owner: string, req: LlmRequest): Promise<LlmResult<T>> {
    const started = Date.now();
    const model = req?.model === "fast" ? this.opts.models.fast : this.opts.models.standard;
    let attempts = 0;
    const failed: FailedAttempt[] = [];
    let res: ModelEnd | undefined;
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
            await this.retryOrThrow(e, attempts, failed, req);
          }
        }
      } finally {
        release();
      }
      const text = res.message.text ?? "";
      const usage: LlmUsage = res.usage;
      const out: LlmResult<T> = { text, model, usage };
      // The SDK helper speaks the pre-adapter finish reasons; only a cut-off answer matters to it.
      if (req.schema) out.json = parseOutput<T>(req.schema, text, res.finish === "length" ? "MAX_TOKENS" : undefined);
      this.record(owner, model, res, started, attempts, failed, "ok");
      return out;
    } catch (e) {
      const error = e instanceof LlmError ? e : new LlmError("unavailable", message(e), { cause: e });
      this.record(owner, model, res ?? answered(error), started, attempts, failed, error);
      throw error;
    }
  }

  /**
   * One streamed model call for `owner` (the chat engine uses `chat`), under the same concurrency slot,
   * per-attempt timeout, error kinds and log line as `generate`. The slot is held until the stream ends.
   * Failures before the first chunk are retried like `generate`; once a chunk reached `onChunk` a
   * failure rejects at once, so a retry can never repeat output.
   */
  async streamCall(owner: string, req: StreamCallRequest, onChunk: (chunk: StreamChunk) => void): Promise<ModelEnd> {
    const started = Date.now();
    let attempts = 0;
    const failed: FailedAttempt[] = [];
    let end: ModelEnd | undefined;
    try {
      const release = await this.slots.acquire(req.signal);
      try {
        for (;;) {
          attempts++;
          let emitted = false;
          try {
            end = await this.streamAttempt(req, (c) => {
              emitted = true;
              onChunk(c);
            });
            break;
          } catch (e) {
            if (emitted) {
              const f = classify(e);
              if (f.reason) failed.push({ reason: f.reason });
              throw f.error;
            }
            await this.retryOrThrow(e, attempts, failed, req);
          }
        }
      } finally {
        release();
      }
      this.record(owner, req.model, end, started, attempts, failed, "ok");
      return end;
    } catch (e) {
      const error = e instanceof LlmError ? e : new LlmError("unavailable", message(e), { cause: e });
      this.record(owner, req.model, end ?? answered(error), started, attempts, failed, error);
      throw error;
    }
  }

  /** Sleeps before the next attempt when the failure is worth one, and throws the typed error otherwise. */
  private async retryOrThrow(e: unknown, attempts: number, failed: FailedAttempt[], req: { signal?: AbortSignal; maxRetryWaitMs?: number }): Promise<void> {
    const f = classify(e);
    if (f.reason) failed.push({ reason: f.reason });
    if (!f.retry) throw f.error;
    if (f.daily) throw new LlmError("unavailable", `rate limited: daily quota ${f.quota} exhausted`, { cause: e });
    const bound = req.maxRetryWaitMs ?? this.maxRetryWaitMs;
    if (f.waitMs !== undefined && f.waitMs > bound) {
      throw new LlmError("unavailable", `rate limited: provider asks to wait ${seconds(f.waitMs)} (limit ${seconds(bound)})`, { cause: e });
    }
    if (attempts > this.delays.length) throw f.error;
    // A stated wait is never shortened: retrying early would only burn the attempt.
    const wait = f.waitMs !== undefined ? f.waitMs * (1 + Math.random() * 0.1) : this.delays[attempts - 1] * (0.8 + Math.random() * 0.4);
    if (f.reason) failed[failed.length - 1].waitMs = wait;
    // The concurrency slot is kept while waiting, so queued calls don't hit the same limit at once.
    await this.sleep(wait, req.signal);
  }

  /** One streamed provider call bounded by the caller's signal and the per-attempt timeout. */
  private async streamAttempt(req: StreamCallRequest, onChunk: (chunk: StreamChunk) => void): Promise<ModelEnd> {
    const ms = req.timeoutMs ?? this.opts.timeoutMs;
    const timeout = AbortSignal.timeout(ms);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const { signal: _signal, timeoutMs: _timeoutMs, maxRetryWaitMs: _maxRetryWaitMs, ...chat } = req;
    const it = this.opts.model.stream(chat, { signal });
    try {
      for (;;) {
        const r = await raceAbort(it.next(), signal);
        if (r.done) return r.value;
        onChunk(r.value);
      }
    } catch (e) {
      void it.return?.(undefined as never)?.catch(() => {});
      if (req.signal?.aborted) throw cancelled();
      if (timeout.aborted) throw new LlmError("unavailable", `timed out after ${ms} ms`);
      throw e;
    }
  }

  /** One provider call bounded by the caller's signal and the per-attempt timeout. */
  private async attempt(model: string, req: LlmRequest): Promise<ModelEnd> {
    const ms = req.timeoutMs ?? this.opts.timeoutMs;
    const timeout = AbortSignal.timeout(ms);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const { system, prompt, messages, schema, temperature, maxOutputTokens } = req;
    const chat: ChatRequest = {
      model,
      messages: messages ? messages.map((m): ChatMessage => (m.role === "model" ? { role: "assistant", text: m.text } : { role: "user", text: m.text })) : [{ role: "user", text: prompt ?? "" }],
    };
    if (system !== undefined) chat.system = system;
    if (schema !== undefined) chat.schema = schema;
    if (temperature !== undefined) chat.temperature = temperature;
    if (maxOutputTokens !== undefined) chat.maxOutputTokens = maxOutputTokens;
    try {
      return await raceAbort(this.opts.model.generate(chat, { signal }), signal);
    } catch (e) {
      if (req.signal?.aborted) throw cancelled();
      if (timeout.aborted) throw new LlmError("unavailable", `timed out after ${ms} ms`);
      throw e;
    }
  }

  /** One line per settled call. Never includes prompts, messages or output. */
  private record(owner: string, model: string, res: Pick<ModelEnd, "model" | "usage"> | undefined, started: number, attempts: number, failed: FailedAttempt[], outcome: "ok" | LlmError): void {
    const u = res?.usage;
    const version = res && res.model !== model ? ` (${res.model})` : "";
    const tokens = u ? ` in=${u.inputTokens} out=${u.outputTokens}${u.thoughtTokens ? ` think=${u.thoughtTokens}` : ""}` : "";
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const why = failed.map((f) => (f.waitMs === undefined ? f.reason : `${f.reason} wait ${seconds(f.waitMs)}`)).join(", ");
    const tries = `(${attempts} attempt${attempts === 1 ? "" : "s"}${why ? `: ${why}` : ""})`;
    if (outcome === "ok") return this.log.log(`llm: [${owner}] ${model}${version} ok${tokens} ${secs}s ${tries}`);
    // Error messages are ours or the provider's status text; invalid_output's `raw` is never logged.
    const detail = outcome.kind === "cancelled" ? "" : `: ${outcome.message.slice(0, 200)}`;
    this.log.warn(`llm: [${owner}] ${model}${version} ${outcome.kind}${detail}${tokens} ${secs}s ${tries}`);
  }
}
