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
| `conversations` | Read access to recorded conversations: `list`, `get`, `onQuiet`. In-process modules only; see [Conversations](#conversations). |

Mark credentials and tokens with `secret: true`. Secrets are stored encrypted and never displayed in the portal; plain keys are shown and edited inline. Retrieval is identical for both: `ctx.config.get` / `require`.

Rules the host enforces:

- Every `required` config key must be set before `init` runs; otherwise the module is reported `failed` with `module <id>: missing required config <keys>` and the rest of Friday starts normally.
- If `init` throws, the tools it registered so far are removed.
- Modules must not depend on each other's tools. Load order is only for deterministic logging.

### Tool results

A handler returns a plain object. Two keys are reserved and stripped before the result reaches the model:

- `scheduling`: `"INTERRUPT" | "WHEN_IDLE" | "SILENT"`, per-call override of how Gemini surfaces the result.
- `endConversation`: a reason string asking the session to close after the model's current turn.

Throwing from a handler yields `{ error: "<message>" }` with `INTERRUPT` so the model can tell the user.

### Conversations

Core records every conversation as transcript text (never audio): user entries with their input (`speech`, transcribed and noisy, or `text`, typed and exact), assistant entries (marked `interrupted` on barge-in), and tool calls with their arguments and results. A conversation is **active** while it receives entries and goes **quiet** when its session ends or after `FRIDAY_CONVERSATION_QUIET_MINUTES` without activity. A resumed thread goes quiet again later, with a later `quietAt`.

- `ctx.conversations.list({ quietSince?, limit? })`: without `quietSince`, the most recently active first. With it, the conversations currently quiet that went quiet after that time, oldest first.
- `ctx.conversations.get(id)`: the conversation with all its entries, or `undefined`.
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

For heavier work, make `catchUp` a background job and have the handler call `ctx.jobs.trigger("<name>")` instead, so runs never overlap and show up on the Jobs page. Remote modules get an error `conversations are not available in this host`. In tests, `createTestHost` provides an in-memory store as `host.conversations`: `seed({ entries, ... })` adds a conversation and `await markQuiet(id)` fires the module's handlers.

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

`createTestHost` initializes the module against an in-memory `ToolRegistry` with `env` as its only configuration source (`process.env` is not consulted), and rejects with the same error the real host would log when a required key is missing. Inject fakes (like `fetch`) through a factory function in your module, as `modules/media` does with `createMediaModule({ fetch })`.

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
