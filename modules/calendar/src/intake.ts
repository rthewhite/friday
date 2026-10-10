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
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(target, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ subject: INTAKE_SUBJECT }),
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      if (timeout.aborted) throw new UpstreamError(`The intake did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`);
      if (signal?.aborted) throw new UpstreamError("The intake poll was cancelled.");
      throw new UpstreamError("The intake could not be reached.");
    }
    if (res.status === 401 || res.status === 403) throw new IntakeRejectedError(res.status);
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      throw new UpstreamError(`The intake answered with a redirect (HTTP ${res.status}), which Friday doesn't follow.`);
    }
    if (!res.ok) throw new UpstreamError(`The intake answered HTTP ${res.status}.`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new UpstreamError("The intake's answer was not JSON.");
    }
    const messages = (body as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(messages)) throw new UpstreamError('The intake\'s answer had no "messages" array.');
    return messages;
  }
}
