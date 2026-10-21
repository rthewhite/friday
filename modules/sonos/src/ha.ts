/** Minimal Home Assistant REST client (copied from modules/media, plus template rendering). */
import type { ModuleConfig } from "@friday/sdk";

export interface HaClient {
  call(domain: string, service: string, data: Record<string, unknown>): Promise<unknown>;
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
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // Read per request, so a token saved in the portal is used without a reload.
  const base = () => ({ url: config.require("HA_URL").replace(/\/$/, ""), token: config.require("HA_TOKEN") });

  /** POST to Home Assistant; errors name `what` and never carry the token. */
  async function post(what: string, path: string, body: unknown): Promise<Response> {
    const { url, token } = base();
    let res: Response;
    try {
      res = await fetchFn(`${url}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : err instanceof Error ? err.message : String(err);
      throw new Error(`home assistant ${what} failed: ${reason}`);
    }
    if (!res.ok) throw new Error(`home assistant ${what} -> ${res.status} ${await res.text()}`);
    return res;
  }

  return {
    async call(domain, service, data) {
      const res = await post(`${domain}.${service}`, `/api/services/${domain}/${service}`, data);
      return res.json();
    },
    async template(template) {
      const res = await post("template", "/api/template", { template });
      return res.text();
    },
  };
}
