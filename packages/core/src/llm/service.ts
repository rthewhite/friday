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
  /** Longest wait before retrying after a rate limit when the request sets none (FRIDAY_LLM_MAX_RETRY_WAIT_MS). */
  maxRetryWaitMs?: number;
  /** Waits between attempts; tests replace it to skip real delays. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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

export interface RateLimitInfo {
  /** The provider's `RetryInfo.retryDelay`, in ms. */
  waitMs?: number;
  /** The exhausted quota (`QuotaFailure` quota id or metric); a daily one when any violation is per day. */
  quota?: string;
}

/**
 * Reads Gemini's 429 body, which the SDK puts JSON-encoded in `ApiError.message`. Best-effort:
 * anything unexpected yields `{}` and the fixed backoff applies.
 */
export function rateLimitInfo(msg: string): RateLimitInfo {
  let details: unknown;
  try {
    details = (JSON.parse(msg) as { error?: { details?: unknown } })?.error?.details;
  } catch {
    return {};
  }
  if (!Array.isArray(details)) return {};
  const out: RateLimitInfo = {};
  for (const d of details as Array<Record<string, unknown>>) {
    const type = typeof d?.["@type"] === "string" ? (d["@type"] as string) : "";
    if (out.waitMs === undefined && type.endsWith("RetryInfo")) {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d.retryDelay ?? ""));
      if (m) out.waitMs = Math.round(Number(m[1]) * 1000);
    }
    if (out.quota === undefined && type.endsWith("QuotaFailure") && Array.isArray(d.violations)) {
      const names = (d.violations as Array<Record<string, unknown>>)
        .map((v) => (typeof v?.quotaId === "string" ? v.quotaId : typeof v?.quotaMetric === "string" ? v.quotaMetric : undefined))
        .filter((n): n is string => !!n);
      out.quota = names.find(isDaily) ?? names[0];
    }
  }
  return out;
}

const isDaily = (quota: string) => /perday/i.test(quota);

export interface Failure extends RateLimitInfo {
  error: LlmError;
  /** Worth another attempt. */
  retry: boolean;
  /** For the log: the HTTP status, or `network`. Absent for our own errors (timeouts, missing key). */
  reason?: string;
}

/** Maps a provider failure (not ours) to a typed error and whether it is worth another attempt. */
export function classify(e: unknown): Failure {
  if (e instanceof LlmError) return { error: e, retry: false };
  const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : undefined;
  if (status === undefined) return { error: new LlmError("unavailable", `model unreachable: ${message(e)}`, { cause: e }), retry: true, reason: "network" };
  const reason = String(status);
  if (status === 429) return { error: new LlmError("unavailable", "model rate-limited (HTTP 429)", { cause: e }), retry: true, reason, ...rateLimitInfo(message(e)) };
  if (TRANSIENT_STATUS.has(status)) return { error: new LlmError("unavailable", `model unavailable (HTTP ${status})`, { cause: e }), retry: true, reason };
  if (status === 400 || status === 404) return { error: new LlmError("invalid_request", `model rejected the request (HTTP ${status}): ${message(e)}`, { cause: e }), retry: false, reason };
  return { error: new LlmError("unavailable", `model call failed (HTTP ${status}): ${message(e)}`, { cause: e }), retry: false, reason };
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
            const f = classify(e);
            if (f.reason) failed.push({ reason: f.reason });
            if (!f.retry) throw f.error;
            if (f.quota && isDaily(f.quota)) throw new LlmError("unavailable", `rate limited: daily quota ${f.quota} exhausted`, { cause: e });
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
        }
      } finally {
        release();
      }
      const reason = res.blockReason ?? (res.finishReason && BLOCKING_FINISH.has(res.finishReason) ? res.finishReason : undefined);
      if (reason) throw new LlmError("blocked", `the model provider blocked the ${res.blockReason ? "prompt" : "response"} (${reason})`, { reason });
      const usage: LlmUsage = res.usage;
      const out: LlmResult<T> = { text: res.text, model, usage };
      if (req.schema) out.json = parseOutput<T>(req.schema, res.text, res.finishReason);
      this.record(owner, model, res, started, attempts, failed, "ok");
      return out;
    } catch (e) {
      const error = e instanceof LlmError ? e : new LlmError("unavailable", message(e), { cause: e });
      this.record(owner, model, res, started, attempts, failed, error);
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
  private record(owner: string, model: string, res: TextResponse | undefined, started: number, attempts: number, failed: FailedAttempt[], outcome: "ok" | LlmError): void {
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
