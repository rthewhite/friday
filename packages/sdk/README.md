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
| `llm.generate(request)` | Text generation through core's model. See [Text generation](#text-generation). |

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

Request fields: `system`, exactly one of `prompt` (string) or `messages` (`{ role: "user" | "model", text }[]`, in order), and optionally `schema`, `model`, `temperature`, `maxOutputTokens`, `signal` and `timeoutMs` (per attempt; default `FRIDAY_LLM_TIMEOUT_MS`). The result is `{ text, model, usage: { inputTokens, outputTokens, thoughtTokens? } }`, plus `json` when a schema was given. Core runs at most `FRIDAY_LLM_CONCURRENCY` calls at a time across all modules (the rest wait in order) and logs one line per call with the module id, model, token counts and latency, never the content.

Every rejection is an `LlmError` with a `kind`:

| Kind | Meaning | Retry? |
|---|---|---|
| `unavailable` | Unreachable, rate-limited, provider error, key not configured, or timed out. Core has already retried transient errors twice. | Later (next job run), not in a tight loop. |
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
