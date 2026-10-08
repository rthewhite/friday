# @friday/sdk

The contract between Friday's core and its modules, plus a test host. Modules depend on this package only; they never import `@friday/core`.

## Module

```ts
import { defineModule, Type } from "@friday/sdk";

export default defineModule({
  manifest: {
    id: "weather",                 // kebab-case, unique per deployment, owner of the module's tools
    label: "Weather",
    description: "Forecasts",
    config: [                      // keys the module reads through ctx.config
      { key: "WEATHER_API_KEY", required: true, secret: true, description: "API key" },
      { key: "WEATHER_UNITS" },    // plain: visible and editable in the portal
    ],
  },
  async init(ctx) {
    ctx.defineTool<{ city: string }>({
      name: "get_weather",
      description: "Weather for a city",
      parameters: { type: Type.OBJECT, properties: { city: { type: Type.STRING } }, required: ["city"] },
      scheduling: "INTERRUPT",     // default for this tool's results
      // channels: ["voice"],      // optional: offer it only in voice (or ["chat"]); both by default
      handler: async ({ city }) => ({ temp_c: 18, sky: "cloudy" }),
    });
    ctx.log.log("ready");          // printed as "[weather] ready"
  },
  async dispose() {},              // optional; called on shutdown in reverse load order
});
```

### `ModuleContext`

| Member | Purpose |
|---|---|
| `defineTool(tool)` | Registers a tool owned by this module. Names are not prefixed; a collision with another module is a load error. |
| `config.get(key)` | Value or `undefined`. Read lazily inside handlers rather than at `init` so later changes are picked up. |
| `config.require(key)` | Value or throws `<id>: <key> is not configured`. |
| `log` | `log`, `warn`, `error`, prefixed with `[<id>]`. |
| `jobs.schedule(job)` | Declares a background job `<id>/<name>` with a `cron` expression (in `FRIDAY_TIMEZONE`) or `everyMs` (at least 1000). Throws on an invalid declaration, so the module fails to load. In-process modules only; on the remote runner it throws `jobs are not available in this host`. |
| `jobs.trigger(name)` | Starts one of the module's own jobs now (trigger `module`); returns `{ started: false }` when it is already running. |
| `llm.generate(request)` | Text generation through core's model. See [Text generation](#text-generation). |
| `conversations` | Read access to recorded conversations: `list`, `get`, `search`, `onQuiet`. In-process modules only; see [Conversations](#conversations). |
| `db` | Synchronous access to the module's own tables: `prepare`, `exec`, `transaction`. In-process modules only; see [Tables](#tables). |
| `prompt.addContext(provider)` | Adds text to Friday's voice and chat system prompts. Returns an unsubscribe function. In-process modules only; see [Prompt context](#prompt-context). |

Mark credentials and tokens with `secret: true`. Secrets are stored encrypted and never displayed in the portal; plain keys are shown and edited inline. Retrieval is identical for both: `ctx.config.get` / `require`.

A job never overlaps itself: a run that comes due while the previous one is still going is recorded as `skipped`. Its handler gets an abort signal (timeout, reload or shutdown), a logger, and the run's trigger (`schedule`, `catch-up`, `manual` or `module`), and may return a short `summary` for the run history:

```ts
const cleanup = defineModule({
  manifest: { id: "cleanup", label: "Cleanup" },
  init(ctx) {
    ctx.jobs.schedule({
      name: "nightly",
      description: "Deletes expired items",
      cron: "0 3 * * *",           // 03:00 in FRIDAY_TIMEZONE; or everyMs: 15 * 60_000
      timeoutMs: 10 * 60_000,      // optional: aborts the signal and records the run as failed
      async run({ signal, log, trigger }) {
        let deleted = 0;
        for (const item of ["a", "b"]) {
          if (signal.aborted) break;   // stop promptly on timeout, reload or shutdown
          deleted++;
        }
        log.log(`cleanup (${trigger}) done`);
        return { summary: `deleted ${deleted} items` };
      },
    });
  },
});
```

A throwing handler records the run as `failed` with its message; the job runs again at its next due time. The module id `core` is reserved for core's own jobs.

Rules the host enforces:

- Every `required` config key must be set before `init` runs; otherwise the module is reported `failed` with `module <id>: missing required config <keys>` and the rest of Friday starts normally.
- Pending `migrations` run after the config check and before `init`. A failing migration fails the module the same way (see [Tables](#tables)).
- If `init` throws, the tools, routes, jobs, subscriptions and prompt context providers it registered so far are removed.
- Modules must not depend on each other's tools. Load order is only for deterministic logging.

### Tool results

A handler returns a plain object. Two keys are reserved and stripped before the result reaches the model:

- `scheduling`: `"INTERRUPT" | "WHEN_IDLE" | "SILENT"`, per-call override of how Gemini surfaces the result.
- `endConversation`: a reason string asking the session to close after the model's current turn.

Throwing from a handler yields `{ error: "<message>" }` with `INTERRUPT` so the model can tell the user.

Both keys matter only in voice. In a portal chat turn the result goes back to the model as is, without them; `scheduling` and `endConversation` are ignored.

A handler's second argument says where the call comes from: `channel` (`"voice"` or `"chat"`) and `conversationId`, the conversation the call is recorded in. The id is absent until that conversation is stored: a voice session writes an exchange when its turn ends, so a tool called in the first exchange has none yet. Both are absent when the host calls a tool directly, such as the remote runner or `host.call(name, args)` without options. Tools from MCP servers and remote modules never see it.

```ts
handler: async ({ query }, { conversationId }) => ({
  found: await ctx.conversations.search({ query, exclude: conversationId ? [conversationId] : [] }),
}),
```

### Channels

A tool is offered in voice sessions and in portal chat unless it sets `channels`, a non-empty list of `"voice"` and `"chat"`. Chat waits for every tool result before it answers (up to `FRIDAY_CHAT_TOOL_TIMEOUT_MS`), so a tool that deliberately takes long, or that only makes sense with a microphone, like `end_conversation`, should be `channels: ["voice"]`. A voice session of a registered device also passes `device` (its id) in the call context; chat and the Talk page never do. Outside its channels a tool is not declared, and a call to it answers `{ error: "unknown tool <name>" }` without running the handler. Remote module tools carry no channels and are offered in both.

### Conversations

Core records every conversation as transcript text (never audio): user entries with their input (`speech`, transcribed and noisy, or `text`, typed and exact), assistant entries (marked `interrupted` on barge-in), and tool calls with their arguments and results. A conversation is **active** while it receives entries and goes **quiet** when its session ends or after `FRIDAY_CONVERSATION_QUIET_MINUTES` without activity. A resumed thread goes quiet again later, with a later `quietAt`.

- `ctx.conversations.list({ quietSince?, limit? })`: without `quietSince`, the most recently active first. With it, the conversations currently quiet that went quiet after that time, oldest first.
- `ctx.conversations.get(id)`: the conversation with all its entries, or `undefined`.
- `ctx.conversations.search({ query?, since?, until?, channel?, device?, exclude?, limit? })`: the conversations whose entries in `[since, until)` (ISO 8601 instants) contain any of the query's words. Words shorter than 3 characters are ignored, and a word matches any part of a word, without case and accents. What is searched is user and assistant text and each tool call's name and the values in its arguments (not their keys), never its result. Results are ordered by the number of distinct words matched, then by most recent activity, and `limit` defaults to 5 (at most 20). Each result is the conversation's summary plus up to 3 `snippets`: the matching entry with the entries before and after it, text cut to 300 characters, tool calls without their result. Without words, it returns the conversations with entries in the window, each with its first 3 of them. An unknown channel, an invalid time or `since` after `until` rejects with a `SearchQueryError`.
- `ctx.conversations.onQuiet(handler)`: called with `{ id, lastActivityAt, quietAt }` each time a conversation goes quiet. Returns an unsubscribe function; subscriptions end when the module is disposed or reloaded. A throwing handler is logged and does not affect other subscribers.

Notifications are best-effort and in-process: one that fires while the module reloads or Friday restarts is lost. The durable pattern is a watermark in `ctx.storage`, with `onQuiet` only as a nudge:

```ts
init(ctx) {
  // Process every conversation that went quiet since the last run, exactly once.
  const catchUp = async () => {
    const since = (await ctx.storage.get<string>("watermark")) ?? new Date(0).toISOString();
    for (const c of await ctx.conversations.list({ quietSince: since, limit: 100 })) {
      const full = await ctx.conversations.get(c.id);
      if (full) summarise(full);
      await ctx.storage.set("watermark", c.quietAt);
    }
  };
  // Going quiet is a best-effort nudge; the watermark makes a missed one (a restart, a reload) harmless.
  let queue = Promise.resolve();
  const nudge = () => (queue = queue.then(catchUp).catch((e) => ctx.log.error("digest failed", e)));
  ctx.conversations.onQuiet(nudge);
  void nudge();
}
```

For heavier work, make `catchUp` a background job and have the handler call `ctx.jobs.trigger("<name>")` instead, so runs never overlap and show up on the Jobs page. Remote modules get an error `conversations are not available in this host`. In tests, `createTestHost` provides an in-memory store as `host.conversations`: `seed({ entries, ... })` adds a conversation, `await markQuiet(id)` fires the module's handlers, and `search` follows the same rules as core, with substring matching over folded text in place of core's full-text index.

### Tables

A module that needs relational data or atomic multi-row writes owns tables in `friday.db`. It declares them as numbered `migrations` and uses them through `ctx.db`:

```ts
import { defineModule, Type } from "@friday/sdk";

export const notes = defineModule({
  manifest: { id: "notes", label: "Notes" },
  migrations: [
    { version: 1, name: "notes", up: "CREATE TABLE notes__notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL, created_at TEXT NOT NULL)" },
    {
      version: 2,
      name: "tags",
      up: (db) => {
        db.exec("CREATE TABLE notes__tags (note INTEGER NOT NULL REFERENCES notes__notes (id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (note, tag))");
        db.exec("CREATE INDEX notes__tags_tag ON notes__tags (tag)");
      },
    },
  ],
  init(ctx) {
    const insertNote = ctx.db.prepare("INSERT INTO notes__notes (text, created_at) VALUES (?, ?)");
    const insertTag = ctx.db.prepare("INSERT INTO notes__tags (note, tag) VALUES (?, ?)");
    const byTag = ctx.db.prepare("SELECT n.id, n.text FROM notes__notes n JOIN notes__tags t ON t.note = n.id WHERE t.tag = ? ORDER BY n.id");

    ctx.defineTool<{ text: string; tags?: string[] }>({
      name: "add_note",
      description: "Saves a note with optional tags",
      parameters: {
        type: Type.OBJECT,
        properties: { text: { type: Type.STRING }, tags: { type: Type.ARRAY, items: { type: Type.STRING } } },
        required: ["text"],
      },
      // The note and its tags are written together or not at all.
      handler: ({ text, tags = [] }) =>
        ctx.db.transaction(() => {
          const id = Number(insertNote.run(text, new Date().toISOString()).lastInsertRowid);
          for (const tag of tags) insertTag.run(id, tag);
          return { id };
        }),
    });
    ctx.defineTool<{ tag: string }>({
      name: "notes_by_tag",
      description: "Notes with a tag",
      parameters: { type: Type.OBJECT, properties: { tag: { type: Type.STRING } }, required: ["tag"] },
      handler: ({ tag }) => ({ notes: byTag.all(tag) }),
    });

    // Tell Friday the notes exist (see Prompt context).
    const count = ctx.db.prepare("SELECT count(*) AS n FROM notes__notes");
    ctx.prompt.addContext(({ channel }) => {
      const { n } = count.get() as { n: number };
      if (!n) return undefined;
      return channel === "voice"
        ? `## Notes\nThe user has ${n} notes; use notes_by_tag to look them up.`
        : `## Notes\nThe user has ${n} saved notes. Use notes_by_tag to find them and cite the note ids.`;
    });
  },
});
```

Migrations:

- Each is `{ version, name, up }`. `version` is a positive integer, unique within the module. `up` is SQL (one or more statements) or a synchronous function that receives `ctx.db`.
- The host validates the whole list, then runs the pending ones in version order after the config check and before `init`, so `init` can rely on the schema. A migration is pending when its version is above the module's recorded version (kept in `friday.db`, per module).
- Each migration runs in its own transaction together with recording its version. One that throws is rolled back, and the module is `failed` with `module <id>: migration <version> "<name>" failed: ...`. Earlier migrations stay applied, and Friday and the other modules start normally.
- A recorded version above the module's highest one (after rolling back to an older image) fails the module with `database schema v3 is newer than module <id>'s migrations (v2)` and runs nothing. There are no down-migrations; ship a new, higher version instead.
- A reload runs any migrations that became pending, and none otherwise. Tables stay when a module is disabled or removed.

`ctx.db`:

- **Synchronous on purpose.** `prepare(sql)` returns node's `StatementSync` (`run`, `get`, `all`, `iterate`; rows are plain objects with a null prototype). `exec(sql)` runs statements without results. Statements may be prepared once in `init` and reused.
- **`transaction(fn)`** runs `fn` in `BEGIN IMMEDIATE`. It commits and returns `fn`'s result when `fn` returns, and rolls back and rethrows when it throws. `fn` must not be async. A body that returns a promise is rolled back and `transaction` throws, and anything the body writes after its first `await` would run outside any transaction. Nested calls use savepoints: an inner `transaction` that throws undoes only its own writes. Because the body cannot await, no other code can interleave with it.
- **The prefix rule.** Everything a module creates or touches is named `<prefix>__*`, where the prefix is its id with `-` replaced by `_`: `notes__notes`, `media_x__cache` for `media-x`. That covers tables, indexes, triggers, views and virtual tables, FTS5 included. An id with `--` or a trailing `-` cannot own tables.
- **What is refused.** A statement that reads, writes, creates, alters or drops anything outside the prefix is refused when it is prepared, with `module <id>: database access refused: <operation>`. That includes core's tables, other modules' tables, the schema-version table, renaming a table to a name outside the prefix, and writing SQLite's shared bookkeeping (`sqlite_sequence`, `sqlite_stat1`). So are pragmas, `ATTACH` and `DETACH`, and `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT`: use `transaction`, which cannot be held open across an `await`. This applies to migrations as well, which already run in a transaction, and a migration that leaves a new object outside the prefix is rolled back. Foreign keys are always enforced. The rule guards against mistakes; it is not a sandbox.
- Keep queries small: they run on the thread that also streams audio. Prefer `INTEGER PRIMARY KEY` or text ids over `AUTOINCREMENT`, whose counters live in a table shared by all modules and can't be adjusted directly.

Remote modules have no database. `runRemote` logs and ignores declared migrations, and every `ctx.db` call throws `<id>: database is not available in this host`.

### Prompt context

`ctx.prompt.addContext(provider)` lets a module prime Friday with what it knows. Core calls every provider each time it builds a system prompt: when a voice session opens (the session keeps it until it closes) and when a chat turn starts (used for every model call of that turn). The provider receives `{ channel }` (`"voice"` or `"chat"`) and returns text or `undefined`. The `notes` module in [Tables](#tables) uses one to say how many notes exist, with a shorter hint for voice than for chat.

- The output goes after the channel's prompt, trimmed, with a blank line between blocks: modules in load order, and a module's providers in registration order. Supply your own heading; core adds none.
- Providers are **synchronous** and on the path that opens a voice session, so read local state (`ctx.db`, memory) only, never the network. One slower than 100 ms is logged with its duration, and one that returns a promise is skipped.
- A module's combined output is cut to `FRIDAY_PROMPT_CONTEXT_MAX_CHARS` (default 12000) characters, ending in `…`, with a warning. A provider that throws or returns nothing is skipped; a throw is logged with the module id.
- Providers are removed when the module is disposed, reloaded or fails in `init`. Remote modules get `<id>: prompt context is not available in this host`.

### Time zone

The household's zone is `FRIDAY_TIMEZONE`. Don't read it with `ctx.config.get` and a default of your own; use the helper, so every module and core's cron fall back the same way:

```ts
import { householdTimeZone, localDate } from "@friday/sdk";

init(ctx) {
  const zone = householdTimeZone(ctx.config, (m) => ctx.log.warn(m));
  // in a handler:
  const today = localDate(new Date(), zone());   // "2026-09-29"
}
```

- `zone()` reads the value on every call, so a zone saved in the portal applies without a reload. Unset, blank or invalid means `DEFAULT_TIME_ZONE` (`Europe/Amsterdam`); an invalid value is warned about once, and again if it comes back after being fixed.
- Declare `FRIDAY_TIMEZONE` in your manifest's `config` when the module depends on it, so the portal lists the module among the key's users.
- `resolveTimeZone(name)` gives `{ zone, valid }` for a zone that doesn't come from config. It's pure `Intl`, so remote modules can use all of this too.

## Text generation

`ctx.llm.generate` runs a one-shot text model call outside any voice session, for background work such as summaries, classification or extraction. Core owns the provider (Gemini), the key and the model; a module picks a tier, never a model name or credentials. Remote modules get a `ctx.llm` that always rejects with `unavailable`.

```ts
import { LlmError, type ModuleContext } from "@friday/sdk";

const factsSchema = {
  type: "object",
  properties: { facts: { type: "array", items: { type: "string" } } },
  required: ["facts"],
};

async function extractFacts(ctx: ModuleContext, transcript: string, signal?: AbortSignal): Promise<string[] | undefined> {
  try {
    const r = await ctx.llm.generate<{ facts: string[] }>({
      system: "Extract durable facts about the user. Return an empty list when there are none.",
      prompt: transcript,             // or messages: [{ role: "user", text }, { role: "model", text }, ...]
      schema: factsSchema,            // optional; the answer is parsed and validated, and returned as r.json
      model: "fast",                  // "standard" (default) or "fast"
      signal,                         // aborting rejects with "cancelled"
    });
    return r.json!.facts;             // r.text, r.model and r.usage are always present
  } catch (e) {
    if (e instanceof LlmError && e.kind === "unavailable") return undefined;   // try again on the next run
    if (e instanceof LlmError && e.kind === "invalid_output") ctx.log.warn(`bad answer: ${e.message}`);
    throw e;
  }
}
```

Request fields: `system`, exactly one of `prompt` (string) or `messages` (`{ role: "user" | "model", text }[]`, in order), and optionally `schema`, `model`, `temperature`, `maxOutputTokens`, `signal`, `timeoutMs` (per attempt; default `FRIDAY_LLM_TIMEOUT_MS`) and `maxRetryWaitMs` (the longest wait before retrying a rate-limited call; default `FRIDAY_LLM_MAX_RETRY_WAIT_MS`, 60000; pass a small value from anything interactive). The result is `{ text, model, usage: { inputTokens, outputTokens, thoughtTokens? } }`, plus `json` when a schema was given. Core runs at most `FRIDAY_LLM_CONCURRENCY` calls at a time across all modules (the rest wait in order) and logs one line per call with the module id, model, token counts and latency, never the content.

Every rejection is an `LlmError` with a `kind`:

| Kind | Meaning | Retry? |
|---|---|---|
| `unavailable` | Unreachable, rate-limited, provider error, key not configured, or timed out. Core has already retried transient errors twice, waiting as long as Gemini asked after a 429 (up to `maxRetryWaitMs`). A longer requested wait or an exhausted daily quota fails at once, with the wait or the quota in the message. | Later (next job run), not in a tight loop. |
| `invalid_output` | With a schema: the answer was not JSON, did not match the schema, or was truncated at `maxOutputTokens`. `raw` carries the text (max 2000 characters). | Optional. Re-asking the same prompt often gives the same answer; skipping the item is usually better. |
| `blocked` | The provider refused the prompt or stopped for safety. `reason` carries the provider's reason (e.g. `SAFETY`). | No, not with the same input. |
| `invalid_request` | Both or neither of `prompt`/`messages`, a schema that is not valid JSON Schema, or a request Gemini rejects (for example an unsupported schema). | No, fix the request. |
| `cancelled` | The `signal` was aborted. | No. |

A conforming empty answer (`{ "facts": [] }`) resolves normally, so "nothing found" and "bad answer" are distinguishable.

Schemas are plain JSON Schema objects, passed to Gemini as `responseJsonSchema` and checked locally with ajv. Gemini supports a subset: `type` (`string`, `number`, `integer`, `boolean`, `object`, `array`, `null`, or a list of these), `title`, `description`, `enum`, `properties`, `required`, `additionalProperties`, `items`, `prefixItems`, `minItems`, `maxItems`, `minimum`, `maximum`, `format` (`date-time`, `date`, `time`; not checked locally), `anyOf`, `$ref` and `$defs`, and `propertyOrdering`. Keep schemas small and flat; a schema that passes ajv but that Gemini rejects fails with `invalid_request` and Gemini's message.

In tests, pass a fake model to `createTestHost`. It receives each request and returns the raw text the model would answer, or throws an `LlmError`. The test host applies the same request checks and schema validation as core (so a non-conforming fake answer gives `invalid_output`), skips the queue, retries and timeout, and records the requests that reached the fake in `host.llmRequests`. Without `llm`, calls reject with `unavailable`.

```ts
const h = await createTestHost(brain, { llm: (req) => (req.schema ? '{"facts": []}' : "A short summary.") });
// ... exercise the module ...
assert.equal(h.llmRequests[0].system, "Extract durable facts about the user. Return an empty list when there are none.");
```

## Testing a module

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import weather from "../src/index.js";

test("get_weather", async () => {
  const h = await createTestHost(weather, { env: { WEATHER_API_KEY: "k" } });
  assert.deepEqual(h.tools, ["get_weather"]);
  const r = await h.call("get_weather", { city: "Utrecht" });
  assert.equal(r.scheduling, "INTERRUPT");
});
```

`host.toolsIn("chat")` lists the tools offered in a channel, and `host.call(name, args, { channel: "chat" })` calls a tool as that channel would.

`createTestHost` initializes the module against an in-memory `ToolRegistry` with `env` as its only configuration source (`process.env` is not consulted), and rejects with the same error the real host would log when a required key is missing.

Scheduled jobs are recorded without running any timers. `host.jobs` lists their names and schedules, and `host.runJob(name)` runs the handler once and resolves to `{ outcome, summary?, error? }`. Declarations are validated as core validates them, so an invalid cron expression rejects `createTestHost`:

```ts
const h = await createTestHost(cleanup);
assert.deepEqual(h.jobs, [{ name: "nightly", cron: "0 3 * * *" }]);
assert.deepEqual(await h.runJob("nightly"), { outcome: "ok", summary: "deleted 2 items" });
```

A module's `migrations` run against a fresh in-memory database before `init`, with the same validation and prefix rules as core, so a broken or non-isolated migration rejects `createTestHost` with the error core would record. `host.db` is the module's `ctx.db`: seed rows before calling a tool and inspect them afterwards. No database file is written. `host.promptContext(channel)` renders the module's prompt context as core would:

```ts
const h = await createTestHost(notes);
h.db.prepare("INSERT INTO notes__notes (text, created_at) VALUES (?, ?)").run("Buy milk", "2026-01-01T00:00:00Z");
await h.call("add_note", { text: "Call the plumber", tags: ["house"] });
assert.deepEqual(h.db.prepare("SELECT tag FROM notes__tags").all().map((r) => r.tag), ["house"]);
assert.equal(h.promptContext("voice"), "## Notes\nThe user has 2 notes; use notes_by_tag to look them up.");
```

Inject fakes (like `fetch`) through a factory function in your module, as `modules/media` does with `createMediaModule({ fetch })`.

## Running a module remotely

The same module can run on another machine and dial into Friday. `@friday/sdk/remote` exports `runRemote`:

```ts
import { runRemote } from "@friday/sdk/remote";
import weather from "./module.js";

const handle = runRemote(weather, {
  url: "wss://friday.thewhite.nl/ws/modules",   // core's remote endpoint
  key: process.env.FRIDAY_MODULE_KEY!,          // must map to manifest.id in core's FRIDAY_MODULE_KEYS
  env: process.env,                             // config source for ctx.config (default)
});

await handle.connected();                        // resolves once core has welcomed this connection
// ...
await handle.stop();                             // closes the socket and calls module.dispose()
```

What happens: the runner calls `init` once against a local registry, sends `hello` with the manifest and key, and after `welcome` serves `tools/list` and `tools/call` over MCP on the same WebSocket. Each tool's default `scheduling` travels in `_meta["friday/scheduling"]`; reserved result keys work unchanged because core flattens the MCP result before resolving them. Core registers the tools as `<id>__<tool>` with owner `remote:<id>` and drops them when the socket closes. The runner reconnects with jittered exponential backoff (1 s to 30 s) except after close codes 4400 (bad hello) and 4401 (unauthorized). Tools added or removed while a voice conversation is open apply to the next conversation.

## Hosting

Core's `ModuleHost` loads modules from a static list (`packages/core/src/modules.ts`), filtered by `FRIDAY_MODULES`. `ToolRegistry` is owner-tagged: `add(owner, tool)`, `removeOwner(owner)`, `declarations()` (a snapshot each voice session takes when it opens), `callTool(name, args)`, `onChange(listener)`, `list()`. The same contract will later be served by a remote runner, so keep modules free of Node-server assumptions.
