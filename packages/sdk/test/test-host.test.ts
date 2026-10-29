import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { defineModule, LlmError, OAuthError, Type, type ModuleContext } from "../src/index.js";
import { createTestHost, TEST_OWNER } from "../src/test.js";
import type { CallUser } from "../src/index.js";

const hello = defineModule({
  manifest: {
    id: "hello",
    label: "Hello",
    config: [{ key: "GREETING", required: true }, { key: "SUFFIX" }],
  },
  init(ctx) {
    ctx.defineTool<{ name: string }>({
      name: "greet",
      description: "Greets",
      parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING } }, required: ["name"] },
      handler: ({ name }) => ({ text: `${ctx.config.require("GREETING")} ${name}${ctx.config.get("SUFFIX") ?? ""}` }),
    });
    ctx.log.log("ready");
  },
});

test("a module's tool is callable without a server", async () => {
  const lines: string[] = [];
  const h = await createTestHost(hello, {
    env: { GREETING: "Hi" },
    log: { log: (...a) => lines.push(a.join(" ")), warn() {}, error() {} },
  });
  assert.deepEqual(h.tools, ["greet"]);
  assert.deepEqual(await h.call("greet", { name: "Ray" }), { result: { text: "Hi Ray" }, scheduling: "INTERRUPT" });
  assert.deepEqual(lines, ["[hello] ready"]);
  assert.deepEqual(h.registry.list()[0].owner, "hello");
});

test("optional config falls back to undefined and process.env is not consulted", async () => {
  process.env.SUFFIX = "!!!";
  try {
    const h = await createTestHost(hello, { env: { GREETING: "Yo" } });
    assert.equal((await h.call("greet", { name: "x" })).result.text, "Yo x");
  } finally {
    delete process.env.SUFFIX;
  }
});

test("missing required config rejects with the host's error", async () => {
  await assert.rejects(createTestHost(hello, { env: {} }), /module hello: missing required config GREETING/);
});

test("dispose is forwarded", async () => {
  let disposed = 0;
  const m = defineModule({ manifest: { id: "d", label: "D" }, init() {}, dispose: () => void disposed++ });
  const h = await createTestHost(m);
  await h.dispose();
  assert.equal(disposed, 1);
});

const factsSchema = { type: "object", properties: { facts: { type: "array", items: { type: "string" } } }, required: ["facts"] };
const extractor = defineModule({
  manifest: { id: "extractor", label: "Extractor" },
  init(ctx) {
    ctx.defineTool<{ text: string }>({
      name: "extract",
      description: "Extracts facts",
      handler: async ({ text }) => {
        try {
          const r = await ctx.llm.generate<{ facts: string[] }>({ system: "Extract facts.", prompt: text, schema: factsSchema });
          return { facts: r.json!.facts, model: r.model };
        } catch (e) {
          if (e instanceof LlmError) return { failed: e.kind, raw: e.raw };
          throw e;
        }
      },
    });
  },
});

test("a fake model answer is validated and returned as json", async () => {
  const h = await createTestHost(extractor, { llm: () => '{"facts": ["sky is blue"]}' });
  assert.deepEqual((await h.call("extract", { text: "the sky is blue" })).result, { facts: ["sky is blue"], model: "fake-standard" });
});

test("a non-conforming fake answer is invalid_output", async () => {
  const h = await createTestHost(extractor, { llm: () => '{"fact":"x"}' });
  assert.deepEqual((await h.call("extract", { text: "t" })).result, { failed: "invalid_output", raw: '{"fact":"x"}' });
});

test("requests reaching the fake are recorded", async () => {
  const h = await createTestHost(extractor, { llm: async () => '{"facts": []}' });
  await h.call("extract", { text: "one" });
  await h.call("extract", { text: "two" });
  assert.deepEqual(h.llmRequests.map((r) => [r.system, r.prompt, r.schema]), [
    ["Extract facts.", "one", factsSchema],
    ["Extract facts.", "two", factsSchema],
  ]);
});

test("the fake can throw LlmError kinds, and invalid requests never reach it", async () => {
  let ctx: ModuleContext | undefined;
  const m = defineModule({ manifest: { id: "m", label: "M" }, init: (c) => void (ctx = c) });
  const h = await createTestHost(m, { llm: () => { throw new LlmError("blocked", "blocked by provider", { reason: "SAFETY" }); } });
  await assert.rejects(ctx!.llm.generate({ prompt: "x" }), (e) => e instanceof LlmError && e.kind === "blocked" && e.reason === "SAFETY");
  await assert.rejects(ctx!.llm.generate({ prompt: "x", messages: [{ role: "user", text: "y" }] }), (e) => e instanceof LlmError && e.kind === "invalid_request");
  assert.equal(h.llmRequests.length, 1);
});

test("without a fake, ctx.llm is unavailable", async () => {
  const h = await createTestHost(extractor);
  assert.deepEqual((await h.call("extract", { text: "t" })).result, { failed: "unavailable", raw: undefined });
  assert.deepEqual(h.llmRequests, []);
});

test("defineTool keeps a tool's channels, and the test host calls as a channel would", async () => {
  const voiceOnly = defineModule({
    manifest: { id: "v", label: "V" },
    init(ctx) {
      ctx.defineTool({ name: "beep", description: "", channels: ["voice"], handler: () => ({ ok: true }) });
      ctx.defineTool({ name: "time", description: "", handler: () => ({ ok: true }) });
    },
  });
  const h = await createTestHost(voiceOnly);
  assert.deepEqual(h.registry.get("beep")?.channels, ["voice"]);
  assert.deepEqual(h.toolsIn("chat"), ["time"]);
  assert.deepEqual(h.toolsIn("voice"), ["beep", "time"]);
  assert.deepEqual((await h.call("beep", {}, { channel: "chat" })).result, { error: "unknown tool beep" });
  assert.deepEqual((await h.call("beep")).result, { ok: true });
});

const items = defineModule({
  manifest: { id: "hello", label: "Hello" },
  migrations: [{ version: 1, name: "items", up: "CREATE TABLE hello__items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)" }],
  init(ctx) {
    ctx.defineTool({ name: "list_items", description: "", handler: () => ({ items: ctx.db.prepare("SELECT name FROM hello__items ORDER BY id").all().map((r) => r.name) }) });
    ctx.defineTool<{ name: string }>({ name: "add_item", description: "", handler: ({ name }) => ({ id: Number(ctx.db.prepare("INSERT INTO hello__items (name) VALUES (?)").run(name).lastInsertRowid) }) });
  },
});

test("the test host runs migrations in memory; tests seed and inspect through host.db", async () => {
  const cwd = readdirSync(".");
  const h = await createTestHost(items);
  h.db.prepare("INSERT INTO hello__items (name) VALUES (?)").run("seeded");
  assert.deepEqual((await h.call("list_items")).result, { items: ["seeded"] });
  await h.call("add_item", { name: "added" });
  assert.deepEqual(h.db.prepare("SELECT name FROM hello__items ORDER BY id").all().map((r) => r.name), ["seeded", "added"]);
  assert.throws(() => h.db.prepare("SELECT * FROM module_schema"), /module hello: database access refused/);
  assert.deepEqual(readdirSync("."), cwd);
  await h.dispose();
});

test("a query in init sees the rows its migrations wrote", async () => {
  let seen: unknown[] = [];
  const m = defineModule({
    manifest: { id: "hello", label: "Hello" },
    migrations: [{ version: 1, name: "items", up: "CREATE TABLE hello__items (name TEXT); INSERT INTO hello__items VALUES ('default')" }],
    init(ctx) { seen = ctx.db.prepare("SELECT name FROM hello__items").all().map((r) => r.name); },
  });
  await createTestHost(m);
  assert.deepEqual(seen, ["default"]);
});

test("a failing or non-isolated migration rejects createTestHost with the host's error, before init", async () => {
  let inits = 0;
  const broken = defineModule({
    manifest: { id: "hello", label: "Hello" },
    migrations: [
      { version: 1, name: "items", up: "CREATE TABLE hello__items (id INTEGER PRIMARY KEY)" },
      { version: 2, name: "oops", up: "CREATE TABLE items (id INTEGER PRIMARY KEY)" },
    ],
    init() { inits++; },
  });
  await assert.rejects(createTestHost(broken), /module hello: migration 2 "oops" failed: module hello: database access refused: create table items/);
  await assert.rejects(createTestHost({ ...broken, migrations: [broken.migrations![0], { ...broken.migrations![0] }] }), /module hello: duplicate migration version 1/);
  assert.equal(inits, 0);
});

test("modules without migrations may still use ctx.db lazily; bad ids fail at use", async () => {
  const m = defineModule({ manifest: { id: "bad-", label: "Bad" }, init() {} });
  const h = await createTestHost(m);
  assert.throws(() => h.db.exec("SELECT 1"), /module bad-: an id with "--" or a trailing "-" cannot own tables/);
  await assert.rejects(createTestHost({ ...m, migrations: [{ version: 1, name: "x", up: "SELECT 1" }] }), /cannot own tables/);
});

test("promptContext renders the module's providers per channel, and dispose drops them", async () => {
  const errors: string[] = [];
  const m = defineModule({
    manifest: { id: "brain", label: "Brain" },
    init(ctx) {
      ctx.prompt.addContext(({ channel }) => `## Brain (${channel})\nThe user is Ray.`);
      ctx.prompt.addContext(() => { throw new Error("broken"); });
    },
  });
  const h = await createTestHost(m, { log: { log() {}, warn() {}, error: (...a) => void errors.push(a.join(" ")) } });
  assert.equal(h.promptContext("voice"), "## Brain (voice)\nThe user is Ray.");
  assert.equal(h.promptContext("chat"), "## Brain (chat)\nThe user is Ray.");
  assert.deepEqual(errors, ["prompt context provider of brain failed: broken", "prompt context provider of brain failed: broken"]);
  await h.dispose();
  assert.equal(h.promptContext("voice"), "");
});

const music = defineModule({
  manifest: { id: "music", label: "Music", oauth: [{ provider: "spotify", scopes: ["playlist-read-private"] }] },
  init(ctx) {
    ctx.defineTool<{ provider: string }>({
      name: "token_for",
      description: "",
      parameters: { type: Type.OBJECT, properties: { provider: { type: Type.STRING } }, required: ["provider"] },
      handler: async ({ provider }) => {
        try {
          return { token: await ctx.oauth.token(provider) };
        } catch (e) {
          return { kind: (e as OAuthError).kind, message: (e as Error).message };
        }
      },
    });
  },
});

test("a fake OAuth token reaches the module", async () => {
  const host = await createTestHost(music, { oauth: { spotify: "t0ken" } });
  assert.deepEqual((await host.call("token_for", { provider: "spotify" })).result, { token: "t0ken" });
});

test("a fake OAuthError is thrown as is, and a function is called on every call", async () => {
  let n = 0;
  const host = await createTestHost(music, { oauth: { spotify: () => (++n === 1 ? new OAuthError("not_granted", "grant it") : `t${n}`) } });
  assert.deepEqual((await host.call("token_for", { provider: "spotify" })).result, { kind: "not_granted", message: "grant it" });
  assert.deepEqual((await host.call("token_for", { provider: "spotify" })).result, { token: "t2" });
  assert.deepEqual(host.oauthCalls, { spotify: 2 });
});

test("a provider the manifest does not request is not_granted, a requested one without a fake is not_connected", async () => {
  const host = await createTestHost(music, { oauth: { github: "gh" } });
  assert.deepEqual((await host.call("token_for", { provider: "github" })).result, { kind: "not_granted", message: "music does not request access to github" });
  assert.deepEqual((await host.call("token_for", { provider: "spotify" })).result, { kind: "not_connected", message: "spotify is not connected in this test host" });
  assert.deepEqual(host.oauthCalls, { github: 1, spotify: 1 });
});

test("an invalid oauth request rejects createTestHost as the host would", async () => {
  const bad = defineModule({ manifest: { id: "bad", label: "Bad", oauth: [{ provider: "acme", scopes: [], authUrl: "https://a.example/x" }] }, init() {} });
  await assert.rejects(createTestHost(bad), /module bad: oauth request for acme: authUrl and tokenUrl go together/);
});

const raymond = { id: "u1", name: "Raymond", role: "admin" as const };
const sanne = { id: "u2", name: "Sanne" };

function usersModule(seen: { owners: CallUser[] }) {
  return defineModule({
    manifest: { id: "u", label: "U" },
    init(ctx) {
      ctx.users.onOwner((o) => void seen.owners.push(o));
      ctx.defineTool({ name: "agenda", description: "", ownerOnly: true, handler: (_a, call) => ({ for: call.user?.id ?? null }) });
      ctx.defineTool({ name: "whoami", description: "", handler: () => ({ owner: ctx.users.owner() ?? null, users: ctx.users.list() }) });
    },
  });
}

test("users: without options the fixed test owner is the owner and the only user", async () => {
  const h = await createTestHost(usersModule({ owners: [] }));
  assert.deepEqual((await h.call("whoami")).result, { owner: TEST_OWNER, users: [TEST_OWNER] });
});

test("users: the user option is the owner, and the list holds the owner and the user", async () => {
  const withUser = await createTestHost(usersModule({ owners: [] }), { user: raymond });
  assert.deepEqual((await withUser.call("whoami")).result, { owner: { id: "u1", name: "Raymond" }, users: [{ id: "u1", name: "Raymond" }] });
  const both = await createTestHost(usersModule({ owners: [] }), { user: { ...sanne, role: "member" }, owner: { id: "u1", name: "Raymond" } });
  assert.deepEqual((await both.call("whoami")).result, { owner: { id: "u1", name: "Raymond" }, users: [{ id: "u1", name: "Raymond" }, sanne] });
});

test("users: the users and owner options, the owner given by id", async () => {
  const h = await createTestHost(usersModule({ owners: [] }), { users: [{ id: "u1", name: "Raymond" }, sanne], owner: "u2" });
  assert.deepEqual((await h.call("whoami")).result, { owner: sanne, users: [{ id: "u1", name: "Raymond" }, sanne] });
  await assert.rejects(createTestHost(usersModule({ owners: [] }), { users: [sanne], owner: "u9" }), /owner "u9" is not one of the test host's users/);
});

test("users: an owner recorded later fires onOwner once, and dispose ends the subscription", async () => {
  const seen = { owners: [] as CallUser[] };
  const h = await createTestHost(usersModule(seen), { users: [{ id: "u1", name: "Raymond" }, sanne], owner: null });
  assert.deepEqual((await h.call("whoami")).result, { owner: null, users: [{ id: "u1", name: "Raymond" }, sanne] });
  await h.recordOwner("u1");
  assert.deepEqual(seen.owners, [{ id: "u1", name: "Raymond" }]);
  assert.deepEqual(((await h.call("whoami")).result as { owner: unknown }).owner, { id: "u1", name: "Raymond" });
  await assert.rejects(h.recordOwner("u2"), /the owner is already recorded/);
  await h.dispose();
  assert.equal(seen.owners.length, 1);
});

test("owner-only tools: calls without a user count as the owner's; a member's are refused and not declared", async () => {
  const h = await createTestHost(usersModule({ owners: [] }), { users: [{ id: "u1", name: "Raymond" }, sanne], owner: "u1" });
  assert.deepEqual((await h.call("agenda")).result, { for: null });
  assert.deepEqual((await h.call("agenda", {}, { user: { id: "u1", name: "Raymond" } })).result, { for: "u1" });
  assert.deepEqual((await h.call("agenda", {}, { user: sanne })).result, { error: "agenda is only available to the household owner" });
  assert.deepEqual(h.toolsIn("chat"), ["agenda", "whoami"]);
  assert.deepEqual(h.toolsIn("chat", sanne), ["whoami"]);
  assert.deepEqual(h.toolsIn("chat", null), ["whoami"]);
});

test("seeded conversations belong to the host's owner unless a seed says otherwise", async () => {
  const h = await createTestHost(usersModule({ owners: [] }), { user: raymond });
  const c = h.conversations.seed();
  assert.equal((await h.conversations.forUser("u1").get(c.id))?.id, c.id);
  assert.equal(await h.conversations.forUser(TEST_OWNER.id).get(c.id), undefined);
});
