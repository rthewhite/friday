/** module-access over HTTP: the access API, the per-user module listing and `/api/tools`, and module routes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule } from "@friday/sdk";
import builtin from "@friday/module-builtin";
import { startAuthApp, type Browser } from "./auth-harness.js";
import type { Person } from "./oidc-fixture.js";

const owner: Person = { sub: "sub-owner", email: "owner@example.org", name: "Owner", groups: ["friday-admins"] };
const kim: Person = { sub: "sub-kim", email: "kim@example.org", name: "Kim", groups: ["friday-admins"] };
const sanne: Person = { sub: "sub-sanne", email: "sanne@example.org", name: "Sanne", groups: ["friday-users"] };

let speakersServed = 0;
const sonos = defineModule({
  manifest: { id: "sonos", label: "Sonos" },
  init(ctx) {
    ctx.defineTool({ name: "sonos_play", description: "", handler: () => ({ ok: true }) });
    ctx.defineTool({ name: "sonos_restart", description: "", handler: () => ({ ok: true }) });
    ctx.http.route("GET", "/speakers", (_req, res) => (speakersServed++, res.json({ speakers: [] })));
  },
});

interface Entry {
  id: string;
  tools: string[];
  available: boolean;
  access?: { mode: string; users: { id: string; name: string }[]; restricted: string[]; knownTools?: string[] };
}

async function household() {
  const app = await startAuthApp({ access: true, modules: [builtin, sonos] });
  const browsers: Record<string, Browser> = {};
  for (const p of [owner, kim, sanne]) {
    browsers[p.name] = app.browser();
    await browsers[p.name].login("/", p);
  }
  const ids = Object.fromEntries(app.users.list().map((u) => [u.name, u.id]));
  const send = (b: Browser, method: string, path: string, body?: unknown) =>
    b.fetch(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  const listing = async (b: Browser) => (await (await b.fetch("/api/modules")).json()) as Entry[];
  const tools = async (b: Browser) => ((await (await b.fetch("/api/tools")).json()) as { name: string }[]).map((t) => t.name);
  return { app, ids, send, listing, tools, owner: browsers.Owner, kim: browsers.Kim, sanne: browsers.Sanne };
}

test("set access: the admin gets the entry with its access, a member's tools and listing follow at once", async () => {
  const h = await household();
  try {
    const res = await h.send(h.owner, "PUT", "/api/modules/sonos/access", { mode: "everyone", users: [h.ids.Kim], restricted: ["sonos_restart"] });
    assert.equal(res.status, 200);
    const entry = (await res.json()) as Entry;
    assert.equal(entry.id, "sonos");
    assert.deepEqual(entry.access, { mode: "everyone", users: [{ id: h.ids.Kim, name: "Kim" }], restricted: ["sonos_restart"], knownTools: ["sonos_play", "sonos_restart"] });
    assert.deepEqual(entry.tools, ["sonos_play", "sonos_restart"], "admins see every tool");

    assert.equal((await h.tools(h.sanne)).includes("sonos_restart"), false);
    assert.equal((await h.tools(h.sanne)).includes("sonos_play"), true);
    assert.equal((await h.tools(h.kim)).includes("sonos_restart"), true);
    const hers = (await h.listing(h.sanne)).find((e) => e.id === "sonos")!;
    assert.deepEqual(hers, { ...hers, tools: ["sonos_play"], available: true });
    assert.equal(hers.access, undefined, "members don't see access settings");
  } finally {
    await h.app.close();
  }
});

test("chosen users: a member without access isn't listed the module, its tools, nor its routes", async () => {
  const h = await household();
  try {
    assert.equal((await h.send(h.owner, "PUT", "/api/modules/sonos/access", { mode: "chosen", users: [h.ids.Sanne], restricted: [] })).status, 200);
    assert.equal((await h.listing(h.sanne)).find((e) => e.id === "sonos")?.available, true);
    assert.equal((await h.send(h.owner, "PUT", "/api/modules/sonos/access", { mode: "chosen", users: [], restricted: [] })).status, 200);

    assert.equal((await h.listing(h.sanne)).some((e) => e.id === "sonos"), false);
    assert.equal((await h.tools(h.sanne)).some((t) => t.startsWith("sonos_")), false);
    const served = speakersServed;
    const route = await h.sanne.fetch("/api/modules/sonos/speakers");
    assert.equal(route.status, 403);
    assert.equal(((await route.json()) as { code: string }).code, "no_access");
    assert.equal(speakersServed, served, "the handler isn't called");
    assert.equal((await h.owner.fetch("/api/modules/sonos/speakers")).status, 200, "the owner is always allowed");

    // Kim is an admin but not chosen: listed everything, with available false; none of the tools.
    const forKim = (await h.listing(h.kim)).find((e) => e.id === "sonos")!;
    assert.equal(forKim.available, false);
    assert.deepEqual(forKim.tools, ["sonos_play", "sonos_restart"]);
    assert.deepEqual(forKim.access?.mode, "chosen");
    assert.equal((await h.tools(h.kim)).some((t) => t.startsWith("sonos_")), false);
    assert.equal((await h.kim.fetch("/api/modules/sonos/speakers")).status, 403);
  } finally {
    await h.app.close();
  }
});

test("admins see the default access on every module but core and builtin", async () => {
  const h = await household();
  try {
    const all = await h.listing(h.owner);
    assert.deepEqual(all.find((e) => e.id === "sonos")?.access, { mode: "everyone", users: [], restricted: [] });
    assert.equal(all.find((e) => e.id === "builtin")?.access, undefined);
    assert.ok(all.every((e) => e.available));
  } finally {
    await h.app.close();
  }
});

test("a member can't change access; bad input answers 400 and changes nothing; core, builtin and unknown ids 404", async () => {
  const h = await household();
  try {
    const good = { mode: "everyone", users: [h.ids.Kim], restricted: ["sonos_restart"] };
    assert.equal((await h.send(h.sanne, "PUT", "/api/modules/sonos/access", good)).status, 403);
    assert.equal((await h.send(h.sanne, "DELETE", "/api/modules/sonos/access")).status, 403);
    assert.equal(h.app.access!.get("sonos"), undefined);

    assert.equal((await h.send(h.owner, "PUT", "/api/modules/sonos/access", good)).status, 200);
    for (const bad of [
      { ...good, users: ["nobody"] },
      { ...good, mode: "some" },
      { ...good, restricted: [""] },
      { ...good, restricted: [7] },
      { ...good, users: "Kim" },
      "{nope",
      [],
    ]) {
      const res = await h.send(h.owner, "PUT", "/api/modules/sonos/access", bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(typeof ((await res.json()) as { error: string }).error, "string");
    }
    assert.deepEqual(h.app.access!.get("sonos")?.users, [h.ids.Kim], "the stored setting is unchanged");

    for (const id of ["core", "builtin", "nope"]) {
      assert.equal((await h.send(h.owner, "PUT", `/api/modules/${id}/access`, good)).status, 404, id);
      assert.equal((await h.send(h.owner, "DELETE", `/api/modules/${id}/access`)).status, 404, id);
    }
  } finally {
    await h.app.close();
  }
});

test("DELETE goes back to the default: every user gets the module again", async () => {
  const h = await household();
  try {
    await h.send(h.owner, "PUT", "/api/modules/sonos/access", { mode: "chosen", users: [], restricted: [] });
    const res = await h.send(h.owner, "DELETE", "/api/modules/sonos/access");
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as Entry).access, { mode: "everyone", users: [], restricted: [] });
    assert.equal((await h.tools(h.sanne)).includes("sonos_play"), true);
    assert.equal((await h.sanne.fetch("/api/modules/sonos/speakers")).status, 200);
  } finally {
    await h.app.close();
  }
});

test("a deleted MCP server takes its access setting with it, so a new one with the same name starts at the default", async () => {
  const h = await household();
  try {
    const server = { name: "home", transport: "http", url: "http://127.0.0.1:9/mcp" };
    assert.equal((await h.send(h.owner, "POST", "/api/mcp/servers", server)).status, 201);
    const set = await h.send(h.owner, "PUT", "/api/modules/mcp:home/access", { mode: "chosen", users: [], restricted: [] });
    assert.equal(set.status, 200);
    assert.equal(h.app.access!.get("mcp:home")?.mode, "chosen");
    assert.equal((await h.send(h.owner, "DELETE", "/api/mcp/servers/home")).status, 204);
    assert.equal(h.app.access!.get("mcp:home"), undefined);
    assert.equal((await h.send(h.owner, "POST", "/api/mcp/servers", server)).status, 201);
    assert.deepEqual((await h.listing(h.owner)).find((e) => e.id === "mcp:home")?.access, { mode: "everyone", users: [], restricted: [] });
  } finally {
    await h.app.close();
  }
});
