import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModuleConfig } from "@friday/sdk";
import { createHa } from "../src/ha.js";
import { fakeHa, env } from "./fake-ha.js";

function config(values: Record<string, string>): ModuleConfig {
  return {
    get: (k) => values[k],
    require: (k) => {
      const v = values[k];
      if (v === undefined) throw new Error(`sonos: ${k} is not configured`);
      return v;
    },
  };
}

test("service calls post with the bearer token to the URL without its trailing slash", async () => {
  const ha = fakeHa();
  await createHa(config(env), { fetch: ha.fetch }).call("media_player", "media_pause", { entity_id: "media_player.x" });
  assert.equal(ha.requests[0].url, "http://ha.local/api/services/media_player/media_pause");
  assert.equal(ha.requests[0].headers.get("authorization"), "Bearer ha-secret-token");
  assert.deepEqual(ha.calls, [{ service: "media_player.media_pause", data: { entity_id: "media_player.x" } }]);
});

test("the template is posted to /api/template and its text returned", async () => {
  const ha = fakeHa([], { templateBody: "[]" });
  const text = await createHa(config(env), { fetch: ha.fetch }).template("{{ 1 }}");
  assert.equal(text, "[]");
  assert.equal(ha.requests[0].url, "http://ha.local/api/template");
  assert.deepEqual(JSON.parse(ha.requests[0].body), { template: "{{ 1 }}" });
});

test("a rejected service call names the service and status, without the token", async () => {
  const ha = fakeHa(undefined, { fail: () => 500 });
  const err = await createHa(config(env), { fetch: ha.fetch }).call("media_player", "join", {}).catch((e: Error) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /media_player\.join -> 500/);
  assert.doesNotMatch(err.message, /ha-secret-token/);
});

test("a failed template names the template request and status", async () => {
  const ha = fakeHa([], { templateStatus: 401 });
  await assert.rejects(createHa(config(env), { fetch: ha.fetch }).template("x"), /home assistant template -> 401/);
});

test("a hanging request times out with an error naming the request, without the token", async () => {
  const hang = ((_: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  const err = await createHa(config(env), { fetch: hang, timeoutMs: 20 }).template("x").catch((e: Error) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /home assistant template failed: no answer within/);
  assert.doesNotMatch(err.message, /ha-secret-token/);
});

test("a body that stalls after the headers still fails naming the request", async () => {
  const stalled = (async () => ({
    status: 200,
    text: async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    },
  })) as unknown as typeof fetch;
  const err = await createHa(config(env), { fetch: stalled, timeoutMs: 20 }).call("media_player", "play_media", {}).catch((e: Error) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /home assistant media_player\.play_media failed: no answer within/);
});

test("a call can wait longer than the client's timeout", async () => {
  let aborted = false;
  const slow = ((_: unknown, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      init?.signal?.addEventListener("abort", () => (aborted = true));
      setTimeout(() => resolve(Response.json([])), 40);
    })) as typeof fetch;
  await createHa(config(env), { fetch: slow, timeoutMs: 10 }).call("media_player", "play_media", {}, 200);
  assert.equal(aborted, false);
});

test("the config is read per request, so a new token is used without rebuilding the client", async () => {
  const values = { ...env };
  const ha = fakeHa();
  const client = createHa(config(values), { fetch: ha.fetch });
  await client.call("media_player", "media_play", {});
  values.HA_TOKEN = "new-token";
  await client.call("media_player", "media_play", {});
  assert.equal(ha.requests[1].headers.get("authorization"), "Bearer new-token");
});
