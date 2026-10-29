/**
 * user-privacy end to end: two people log in through the (fake) provider, chat, and use the brain, agents and the
 * calendar, with the real brain and calendar modules on a fake model. What one says never reaches the other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmRequest, ModuleLlm, ToolRegistry } from "@friday/sdk";
import brain from "@friday/module-brain";
import calendar from "@friday/module-calendar";
import { ChatEngine } from "../src/chat/engine.js";
import type { ModuleHost } from "../src/module-host.js";
import { ConversationStore } from "../src/conversations/store.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import { AgentRunStore, AgentStore } from "../src/agents/store.js";
import { moduleUsers } from "../src/auth/ownership.js";
import { createPromptContext } from "../src/prompt-context.js";
import { SqliteModuleStorage } from "../src/storage/module-kv.js";
import { JobStore } from "../src/jobs/store.js";
import { Scheduler } from "../src/jobs/scheduler.js";
import { FakeClock } from "./fake-clock.js";
import { admin, member, startAuthApp, type Browser } from "./auth-harness.js";
import { fakeStream, text } from "./fake-stream.js";

const quiet = { log() {}, warn() {}, error() {} };

/** The brain's model: extraction notes what each conversation is about on page `Chores`; the rest does nothing. */
const brainLlm: ModuleLlm = {
  async generate<T>(req: LlmRequest) {
    const props = (req.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    let json: unknown = { actions: [], note: "nothing to tidy" };
    if (props.summary) json = { summary: "" };
    if (props.notes) {
      const fact = req.prompt?.includes("glasshouse") ? "The glasshouse needs a new pane." : req.prompt?.includes("piano") ? "The piano needs tuning." : undefined;
      json = { notes: fact ? [{ entity: "Chores", fact, type: "other", reason: "said by the user" }] : [] };
    }
    return { text: JSON.stringify(json), json: json as T, model: "fake", usage: { inputTokens: 0, outputTokens: 0 } };
  },
};

async function household() {
  const dir = mkdtempSync(join(tmpdir(), "friday-privacy-"));
  const chatModel = fakeStream({ chunks: [text("Noted.")] });
  let store: ConversationStore | undefined;
  let tools: ToolRegistry | undefined;
  let host: ModuleHost | undefined;
  let scheduler: Scheduler | undefined;
  const app = await startAuthApp({
    modules: [brain, calendar],
    hostOptions: ({ db, users }) => {
      store = new ConversationStore(db, { log: quiet });
      // A clock that never moves: jobs are registered (calendar's refresh, brain/nightly) but only run when asked.
      scheduler = new Scheduler({ store: new JobStore(db), clock: new FakeClock(Date.parse("2026-10-29T12:00:00Z")), log: quiet, timezone: "Europe/Amsterdam" });
      // As server.ts wires the host, with a fake model behind ctx.llm.
      return {
        // The calendar loads on its intake alone; nothing listens there, so its refreshes fail, which is fine here.
        env: { INTAKE_URL: "http://127.0.0.1:9/intake", INTAKE_KEY: "k" },
        conversations: (id) => store!.forOwner(id),
        users: moduleUsers(users),
        database: join(dir, "friday.db"),
        storage: (id) => new SqliteModuleStorage(db, id),
        prompt: createPromptContext({ log: quiet }),
        llm: () => brainLlm,
        jobs: (id) => scheduler!.forOwner(id),
      };
    },
    deps: ({ registry, db, host: h }) => {
      tools = registry;
      host = h;
      const agents = new AgentStore(db);
      const runs = new AgentRunStore(db);
      const runtime = new AgentRuntime({ agents, runs, registry, conversations: store!, llm: fakeStream({ chunks: [text("done")] }).llm, model: "m", timezone: () => "Europe/Amsterdam", toolTimeoutMs: 1000, log: quiet });
      return {
        conversations: store,
        chat: new ChatEngine({ store: store!, registry, llm: chatModel.llm, model: "m", system: () => "P", toolTimeoutMs: 1000, log: quiet }),
        agents: { agents, runs, runtime, registry, nextRun: () => null },
      };
    },
  });
  const owner = app.browser();
  await owner.login("/", admin);
  const sanne = app.browser();
  await sanne.login("/", member);
  const ids = new Map(app.users.list().map((u) => [u.name, u.id]));
  return { app, owner, sanne, ids, store: store!, registry: tools!, chatModel, loaded: () => host!.loaded(), close: async () => { await scheduler!.stop(); await host!.dispose(); await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function chat(b: Browser, text: string): Promise<string> {
  const res = await b.fetch("/api/chat", json({ text }));
  assert.equal(res.status, 200);
  return /"conversationId":"([^"]+)"/.exec(await res.text())![1];
}

test("two users: chats, the brain, agents and the calendar stay with their own user", async () => {
  const h = await household();
  try {
    assert.deepEqual(h.loaded().filter((m) => m.status !== "loaded"), [], "brain and calendar load");
    const owner = { id: h.ids.get("Owner")!, name: "Owner" };
    const sanne = { id: h.ids.get("Sanne")!, name: "Sanne" };
    const mine = await chat(h.owner, "the glasshouse needs a new pane");
    const hers = await chat(h.sanne, "the piano needs tuning before Christmas");

    // The API: each lists only their own thread; the admin owner can't open hers, nor she his.
    const listed = async (b: Browser) => ((await (await b.fetch("/api/conversations")).json()) as { conversations: { id: string }[] }).conversations.map((c) => c.id);
    assert.deepEqual(await listed(h.owner), [mine]);
    assert.deepEqual(await listed(h.sanne), [hers]);
    assert.equal((await h.owner.fetch(`/api/conversations/${hers}`)).status, 404);
    assert.equal((await h.sanne.fetch(`/api/conversations/${mine}`)).status, 404);

    // brain_recall_conversations, as a chat turn calls it, searches only the caller's own conversations.
    const recall = async (user: typeof owner, query: string) =>
      (((await h.registry.callTool("brain_recall_conversations", { query }, { channel: "chat", user })).result as { conversations?: { id: string }[] }).conversations ?? []).map((c) => c.id);
    assert.deepEqual(await recall(owner, "piano"), []);
    assert.deepEqual(await recall(owner, "glasshouse"), [mine]);
    assert.deepEqual(await recall(sanne, "glasshouse"), []);
    assert.deepEqual(await recall(sanne, "piano"), [hers]);

    // The nightly pass: each runs their own, and what each said lands only in their own brain.
    for (const id of [mine, hers]) h.store.markQuiet(id);
    for (const b of [h.owner, h.sanne]) assert.equal((await b.fetch("/api/modules/brain/runs/now", { method: "POST" })).status, 202);
    const chores = async (b: Browser) => {
      for (let i = 0; i < 200; i++) {
        const pages = ((await (await b.fetch("/api/modules/brain/pages")).json()) as { pages: { name: string; body: string }[] }).pages;
        const page = pages.find((p) => p.name === "Chores");
        if (page) return page.body;
        await new Promise((r) => setTimeout(r, 10));
      }
      return "";
    };
    const ownerChores = await chores(h.owner);
    const sanneChores = await chores(h.sanne);
    assert.match(ownerChores, /glasshouse/);
    assert.doesNotMatch(ownerChores, /piano/);
    assert.match(sanneChores, /piano/);
    assert.doesNotMatch(sanneChores, /glasshouse/);

    // Agents: the owner's agent is invisible to Sanne, and she can't run it.
    const def = { name: "weekly-review", description: "Sums up my week", instructions: "Sum up my week.", startable: true };
    assert.equal((await h.owner.fetch("/api/agents", json(def))).status, 201);
    assert.deepEqual(((await (await h.sanne.fetch("/api/agents")).json()) as { agents: unknown[] }).agents, []);
    assert.equal((await h.sanne.fetch("/api/agents/weekly-review")).status, 404);
    assert.equal((await h.sanne.fetch("/api/agents/weekly-review/run", json({}))).status, 404);

    // The calendar: Sanne's chat turn offers no calendar tools, the owner's does; its routes refuse her.
    h.chatModel.requests.length = 0;
    await chat(h.sanne, "what's on my calendar today?");
    await chat(h.owner, "what's on my calendar today?");
    const offered = h.chatModel.requests.map((r) => (r.tools ?? []).map((d) => d.name).filter((n) => n.startsWith("calendar_")));
    assert.deepEqual(offered[0], []);
    assert.ok(offered[1]!.includes("calendar_list_events"));
    assert.equal((await h.sanne.fetch("/api/modules/calendar/status")).status, 403);
    assert.equal((await h.owner.fetch("/api/modules/calendar/status")).status, 200);
  } finally {
    await h.close();
  }
});
