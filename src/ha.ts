/** Minimal Home Assistant REST client. Env: HA_URL, HA_TOKEN. */
function base(): { url: string; token: string } {
  const url = process.env.HA_URL?.replace(/\/$/, "");
  const token = process.env.HA_TOKEN;
  if (!url || !token) throw new Error("HA_URL / HA_TOKEN not configured");
  return { url, token };
}

export async function haCall(domain: string, service: string, data: Record<string, unknown>): Promise<unknown> {
  const { url, token } = base();
  const res = await fetch(`${url}/api/services/${domain}/${service}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`home assistant ${domain}.${service} -> ${res.status} ${await res.text()}`);
  return res.json();
}

export async function haState(entityId: string): Promise<{ state: string; attributes: Record<string, unknown> }> {
  const { url, token } = base();
  const res = await fetch(`${url}/api/states/${entityId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`home assistant state ${entityId} -> ${res.status}`);
  return res.json() as Promise<{ state: string; attributes: Record<string, unknown> }>;
}
