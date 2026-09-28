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
| `jobs.schedule(job)` | Declares a background job `<id>/<name>` with a `cron` expression (in `FRIDAY_TIMEZONE`) or `everyMs` (at least 1000). Throws on an invalid declaration, so the module fails to load. In-process modules only; on the remote runner it throws `jobs are not available in this host`. |
| `jobs.trigger(name)` | Starts one of the module's own jobs now (trigger `module`); returns `{ started: false }` when it is already running. |

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
- If `init` throws, the tools it registered so far are removed.
- Modules must not depend on each other's tools. Load order is only for deterministic logging.

### Tool results

A handler returns a plain object. Two keys are reserved and stripped before the result reaches the model:

- `scheduling`: `"INTERRUPT" | "WHEN_IDLE" | "SILENT"`, per-call override of how Gemini surfaces the result.
- `endConversation`: a reason string asking the session to close after the model's current turn.

Throwing from a handler yields `{ error: "<message>" }` with `INTERRUPT` so the model can tell the user.

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

`createTestHost` initializes the module against an in-memory `ToolRegistry` with `env` as its only configuration source (`process.env` is not consulted), and rejects with the same error the real host would log when a required key is missing.

Scheduled jobs are recorded without running any timers. `host.jobs` lists their names and schedules, and `host.runJob(name)` runs the handler once and resolves to `{ outcome, summary?, error? }`. Declarations are validated as core validates them, so an invalid cron expression rejects `createTestHost`:

```ts
const h = await createTestHost(cleanup);
assert.deepEqual(h.jobs, [{ name: "nightly", cron: "0 3 * * *" }]);
assert.deepEqual(await h.runJob("nightly"), { outcome: "ok", summary: "deleted 2 items" });
``` Inject fakes (like `fetch`) through a factory function in your module, as `modules/media` does with `createMediaModule({ fetch })`.

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
