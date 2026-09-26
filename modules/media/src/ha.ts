/** Minimal Home Assistant REST client. */
import type { ModuleConfig } from "@friday/sdk";

export interface HaClient {
  call(domain: string, service: string, data: Record<string, unknown>): Promise<unknown>;
  state(entityId: string): Promise<{ state: string; attributes: Record<string, unknown> }>;
}

export function createHa(config: ModuleConfig, fetchFn: typeof fetch = fetch): HaClient {
  const base = () => ({ url: config.require("HA_URL").replace(/\/$/, ""), token: config.require("HA_TOKEN") });
  return {
    async call(domain, service, data) {
      const { url, token } = base();
      const res = await fetchFn(`${url}/api/services/${domain}/${service}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`home assistant ${domain}.${service} -> ${res.status} ${await res.text()}`);
      return res.json();
    },
    async state(entityId) {
      const { url, token } = base();
      const res = await fetchFn(`${url}/api/states/${entityId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`home assistant state ${entityId} -> ${res.status}`);
      return res.json() as Promise<{ state: string; attributes: Record<string, unknown> }>;
    },
  };
}
