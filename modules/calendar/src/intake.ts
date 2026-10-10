/**
 * The intake client (design D3): one authenticated POST that returns, and removes, the work calendar deliveries the
 * Power Automate flow left at the intake. A dumb transport: choosing and checking a delivery is work.ts's job.
 * The key goes only to INTAKE_URL (redirects are refused), and no error or log line ever contains it.
 */
import { IntakeRejectedError, UpstreamError } from "./errors.js";

export const INTAKE_SUBJECT = "calendar";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface IntakeConfig {
  url: string;
  key: string;
}

export interface IntakeOptions {
  fetch?: typeof fetch;
  /** Read for every poll, so a key saved later is used at once. */
  config: () => IntakeConfig;
  timeoutMs?: number;
}

export class IntakeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: IntakeOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Takes every waiting calendar delivery off the intake: the `messages` array, possibly empty. */
  async poll(signal?: AbortSignal): Promise<unknown[]> {
    const { url, key } = this.opts.config();
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new UpstreamError("INTAKE_URL is not a valid URL.");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new UpstreamError("INTAKE_URL must be an http or https URL.");
    // The timeout and the caller's signal may cancel the request only until the intake answers: by then it has
    // removed the deliveries it is sending, so the body is read to the end whatever happens.
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.timeoutMs);
    const cancel = () => abort.abort();
    if (signal?.aborted) cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    let res: Response;
    try {
      res = await this.fetchImpl(target, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ subject: INTAKE_SUBJECT }),
        redirect: "manual",
        signal: abort.signal,
      });
    } catch {
      if (timedOut) throw new UpstreamError(`The intake did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`);
      if (signal?.aborted) throw new UpstreamError("The intake poll was cancelled.");
      throw new UpstreamError("The intake could not be reached.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
    if (res.status === 401 || res.status === 403) throw new IntakeRejectedError(res.status);
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      throw new UpstreamError(`The intake answered with a redirect (HTTP ${res.status}), which Friday doesn't follow.`);
    }
    if (!res.ok) throw new UpstreamError(`The intake answered HTTP ${res.status}.`);
    let text: string;
    try {
      text = await res.text();
    } catch {
      // The intake has already let go of whatever it was sending.
      throw new UpstreamError("The intake's answer broke off while it was being read; any delivery in it is lost (the next hourly one replaces it).");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new UpstreamError("The intake's answer was not JSON.");
    }
    const messages = (body as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(messages)) throw new UpstreamError('The intake\'s answer had no "messages" array.');
    return messages;
  }
}
