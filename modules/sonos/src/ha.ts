/** Minimal Home Assistant REST client (copied from modules/media, plus template rendering). */
import type { ModuleConfig } from "@friday/sdk";

export interface HaClient {
  /** `timeoutMs` overrides the client's timeout for one slow service (Sonos share links). */
  call(domain: string, service: string, data: Record<string, unknown>, timeoutMs?: number): Promise<void>;
  /** Render a template with POST /api/template and return the text. */
  template(template: string): Promise<string>;
}

export interface HaOptions {
  fetch?: typeof fetch;
  /** Per request; defaults to 15 s. */
  timeoutMs?: number;
}

export function createHa(config: ModuleConfig, opts: HaOptions = {}): HaClient {
  const fetchFn = opts.fetch ?? fetch;
  const defaultTimeout = opts.timeoutMs ?? 15_000;
  // Read per request, so a token saved in the portal is used without a reload.
  const base = () => ({ url: config.require("HA_URL").replace(/\/$/, ""), token: config.require("HA_TOKEN") });

  /**
   * POST to Home Assistant and read the whole body inside the same timeout and error wrapping, so
   * a stall or drop while reading still names `what`. Errors never carry the token.
   */
  async function post(what: string, path: string, body: unknown, timeoutMs: number): Promise<string> {
    const { url, token } = base();
    let status: number;
    let text: string;
    try {
      const res = await fetchFn(`${url}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : err instanceof Error ? err.message : String(err);
      throw new Error(`home assistant ${what} failed: ${reason}`);
    }
    if (status < 200 || status > 299) throw new Error(`home assistant ${what} -> ${status} ${text}`);
    return text;
  }

  return {
    async call(domain, service, data, timeoutMs) {
      // The changed states HA answers with are not needed: the next lookup reads them fresh.
      await post(`${domain}.${service}`, `/api/services/${domain}/${service}`, data, timeoutMs ?? defaultTimeout);
    },
    template(template) {
      return post("template", "/api/template", { template }, defaultTimeout);
    },
  };
}
