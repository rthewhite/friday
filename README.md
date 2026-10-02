# Friday

Voice assistant on **Gemini 3.8 Live** (TypeScript / Node) built as a small core that hosts modules.

```
browser portal (Vue)   ── WebSocket PCM ──┐
                                          ├─► core ── Gemini Live (PCM 16k in / 24k out)
ESP32 / Voice PE       ── WebSocket PCM ──┘    │
portal Chat page       ── /api/chat (SSE) ────►├── Gemini text model (chat turns, streamed, with tools)
                                               ├─► modules/builtin   time, timers, end_conversation
                                               ├─► modules/media     Jellyfin + Apple TV
                                               ├─► modules/brain     long-term memory (pages, profile)
                                               ├─► modules/travel    driving time with traffic (TomTom)
                                               ├─► MCP servers       configured in the portal (HTTP)
                                               └─◄ remote modules    dial in over /ws/modules (e.g. remote/simracing)
```

The repo is a pnpm workspace:

| Package | Path | What |
|---|---|---|
| `@friday/sdk` | `packages/sdk` | The module contract (`defineModule`, `ModuleContext`, `ToolRegistry`) and a test host |
| `@friday/core` | `packages/core` | HTTP server, `/ws/audio`, `GeminiSession`, the chat engine (`/api/chat`), module host, MCP servers, serves the portal |
| `@friday/portal` | `packages/portal` | Vue 3 + Vite + Tailwind shell: Talk, Chat, Conversations, Modules, and module pages |
| `@friday/portal-ui` | `packages/portal-ui` | Design tokens, base components, `defineModuleUi` |
| `@friday/module-builtin` | `modules/builtin` | `get_current_time`, `set_timer`, `end_conversation` |
| `@friday/module-media` | `modules/media` | Jellyfin library and Apple TV (Infuse) playback via Home Assistant |
| `@friday/module-brain` | `modules/brain` | Long-term memory: `brain_remember`, `brain_recall`, `brain_recall_conversations`, prompt context and the `/m/brain` page (see [Memory](#memory)) |
| `@friday/module-travel` | `modules/travel` | `get_travel_time`: driving time with live or predicted traffic via TomTom (see [Travel time](#travel-time-tomtom)) |
| `@friday/remote-simracing` | `remote/simracing` | Remote module for the gaming PC (mock telemetry for now); not part of the image |

## Run

```sh
cp .env.example .env      # add GEMINI_API_KEY
pnpm install
pnpm dev                  # core on :8080 (tsx watch) + Vite dev server on http://localhost:5173 with hot reload
```

`pnpm dev` builds the workspace first, then runs core and the portal's Vite server side by side. Vite proxies `/api`, `/health` and `/ws` to core, so open http://localhost:5173. For a production-like run, `pnpm build && pnpm start` serves the built portal from core on :8080.

`pnpm test` builds everything and runs every package's tests. `FRIDAY_MODULES=builtin,media` narrows which in-process modules load; `GET /api/modules` shows each module's status and tools.

Browsers only allow the microphone on `localhost` or HTTPS.

### Ending a conversation

The session closes itself in two ways:

- Friday calls the `end_conversation` tool once a request is fully handled and it has no follow-up question, or when you say "goodbye", "thanks", "that's all", etc. The session closes after its final words. If those words end with a question (`?`, `？`, `؟` or Greek `;`, also when followed by `!`, `.` or `…`), the session ignores the request and keeps listening so you can answer. If you don't answer, the idle timeout below closes it with `ended: no follow-up (end after question)`.
- If you stay silent for `FRIDAY_IDLE_TIMEOUT_MS` (default 8000) after Friday finishes a turn, the session closes. Set to `0` to disable. The timer is paused while a tool (e.g. a timer) is still running.

Clients receive `{"type":"closed","data":"ended: ..."}` and should stop capturing but finish playing queued audio.

### Barge-in and echo

Gemini interrupts itself when it detects the user speaking. On speaker devices a little of Friday's own voice leaks back into the microphone before echo cancellation converges, which Gemini can mistake for speech. `FRIDAY_VAD_START_SENSITIVITY` (default `LOW`) and `FRIDAY_VAD_PREFIX_MS` (default 200) tune how eagerly Gemini treats sound as the user talking; raise sensitivity to `HIGH` or lower the padding if barge-in feels sluggish on headphones or the browser.

## Add a module

A module is a workspace package that depends only on `@friday/sdk` and exports a `defineModule`. Core never imports a module's internals; the module gets everything through `ctx`.

```ts
// modules/weather/src/index.ts
import { defineModule, Type } from "@friday/sdk";

export default defineModule({
  manifest: {
    id: "weather",
    label: "Weather",
    config: [{ key: "WEATHER_API_KEY", required: true }],
  },
  init(ctx) {
    ctx.defineTool<{ city: string }>({
      name: "get_weather",
      description: "Weather for a city",
      parameters: { type: Type.OBJECT, properties: { city: { type: Type.STRING } }, required: ["city"] },
      handler: async ({ city }) => ({ temp_c: 18, sky: "cloudy", key: ctx.config.require("WEATHER_API_KEY") }),
    });
  },
});
```

Then add the package to `packages/core/package.json` and to the list in `packages/core/src/modules.ts`. Test it without a server:

```ts
import { createTestHost } from "@friday/sdk/test";
const h = await createTestHost(weather, { env: { WEATHER_API_KEY: "x" } });
await h.call("get_weather", { city: "Utrecht" });   // -> { result, scheduling }
```

`scheduling` controls how Gemini surfaces the result: `INTERRUPT` (default), `WHEN_IDLE`, or `SILENT`; a handler can override it per call by returning a `scheduling` key. Returning an `endConversation: "<reason>"` key asks the session to close after the model's turn (this is how `end_conversation` works). Both keys are stripped before the result reaches Gemini. Calls run in the background so audio keeps flowing during slow tools. A tool is offered in voice and in chat unless it sets `channels` (`["voice"]` or `["chat"]`); `set_timer` and `end_conversation` are voice-only, because a chat turn waits for every result and has no microphone to close. Modules whose `required` config is missing fail to load with a clear error while the rest of Friday starts; see `packages/sdk/README.md` for the full contract.

A module that keeps relational data declares `migrations` and uses `ctx.db`, a synchronous handle on its own tables in `friday.db`. It can also add what it knows to Friday's system prompts with `ctx.prompt.addContext`:

```ts
// modules/pantry/src/index.ts
import { defineModule, Type } from "@friday/sdk";

export default defineModule({
  manifest: { id: "pantry", label: "Pantry" },
  // Pending migrations run before init, each in its own transaction. Tables must be named pantry__*.
  migrations: [{ version: 1, name: "items", up: "CREATE TABLE pantry__items (name TEXT PRIMARY KEY, qty INTEGER NOT NULL)" }],
  init(ctx) {
    const upsert = ctx.db.prepare("INSERT INTO pantry__items (name, qty) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET qty = qty + excluded.qty");
    const low = ctx.db.prepare("SELECT name FROM pantry__items WHERE qty <= 1 ORDER BY name");
    ctx.defineTool<{ items: { name: string; qty: number }[] }>({
      name: "stock_pantry",
      description: "Adds items to the pantry",
      parameters: {
        type: Type.OBJECT,
        properties: { items: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, qty: { type: Type.INTEGER } }, required: ["name", "qty"] } } },
        required: ["items"],
      },
      // All items or none: a transaction body is synchronous, so nothing else can interleave.
      handler: ({ items }) => ctx.db.transaction(() => {
        for (const i of items) upsert.run(i.name, i.qty);
        return { stocked: items.length };
      }),
    });
    // Called when a voice session opens and when a chat turn starts; keep it synchronous and cheap.
    ctx.prompt.addContext(() => {
      const names = low.all().map((r) => r.name);
      return names.length ? `## Pantry\nRunning low on: ${names.join(", ")}.` : undefined;
    });
  },
});
```

A statement that touches anything outside the module's `pantry__` prefix (core's tables, other modules' tables), runs a pragma or attaches a database is refused. A failing migration fails only that module. In tests, `createTestHost` runs the migrations on an in-memory database and offers `host.db` and `host.promptContext("voice")`. Remote modules have neither `ctx.db` nor `ctx.prompt`.

## Portal

The browser UI is a Vue single-page app served by core at `/` with an SPA fallback. It has a `Talk` page (the voice client), a `Chat` page (typed threads, see [Chat](#chat)), a `Conversations` page (the transcript history), a `Modules` page (everything `/api/modules` reports, with status and tools), and one page per module that ships a UI. Design tokens and base components live in `@friday/portal-ui`.

### Add a module UI

1. In the module's `package.json`, add `"friday": { "ui": "./src/ui/index.ts" }`, an export `"./ui": "./src/ui/index.ts"`, and `vue` as an optional peer dependency. Exclude `src/ui` from the module's own `tsconfig.json`; the portal's `vue-tsc` type-checks it.
2. Export a `defineModuleUi({ id, nav: { label, icon, order }, routes })` from that file. `icon` is a `portal-ui` icon name such as `play`, `grid` or `server` (or short text). Routes are Vue Router records relative to `/m/<id>`; `""` is the index page. Use `PageLayout` with `eyebrow="Modules"`, `DataTable` and `Drawer` from `@friday/portal-ui` so the page matches the shell; see `packages/portal-ui/README.md`.
3. Set `ui: true` in the module manifest and add the module package to `packages/portal/package.json` dependencies.
4. Need a backend? Register routes in `init` with `ctx.http.route("GET", "search", handler)`; they are served at `/api/modules/<id>/search`. `createTestHost(...).request()` exercises them in tests.

The portal's build step scans the workspace for `friday.ui` declarations and generates the import list, so no shell code changes are needed. Nav items for modules that are disabled or failed are hidden, and their pages show a notice. See `modules/media/src/ui` for the first example.

## Conversations

Friday keeps a text record of every conversation in `friday.db`, for the portal's history and for background work that reads what was said.

- **What is stored.** Transcript text only, never audio. A conversation has a channel (`voice` or `chat`), the voice device's id when it came from one (the portal shows the device's label), its start and last-activity times, and how it ended (`ended: done`, `ended: no follow-up`, `ended: no follow-up (end after question)`, `client closed`). Its entries are the user's turns, marked `speech` (Gemini's transcription, noisy) or `text` (typed, exact); Friday's answers, marked interrupted on a barge-in; and each tool call with its arguments and result, cut at 4000 characters. A session in which nothing was said, such as a false wake, leaves nothing behind. Whoever speaks near a Voice PE ends up in the record.
- **Quiet.** A voice conversation goes quiet when its session closes; any conversation goes quiet after `FRIDAY_CONVERSATION_QUIET_MINUTES` (default 30) without activity. In-process modules read conversations and hear when one goes quiet through `ctx.conversations` (see `packages/sdk/README.md`).
- **Search.** A full-text index covers what was said: user and assistant text, and each tool call's name and the values in its arguments (not their keys), never its result. It is kept in step with the record, including deletes and retention, and was built for older conversations on upgrade. Friday searches it with `brain_recall_conversations` (see [Memory](#memory)), and modules with `ctx.conversations.search`.
- **Retention.** A nightly core job at 04:00 deletes conversations whose last activity is older than `FRIDAY_CONVERSATION_RETENTION_DAYS` (default 90). `0` keeps them forever.
- **Browsing and deleting.** The portal's `Conversations` page (under Assistant) lists them, shows the transcript and tool activity in a side panel, and deletes a conversation after confirmation. Chat threads there have `Open in Chat`. Over HTTP:

```sh
curl -s 'localhost:8080/api/conversations?limit=20'        # {"conversations":[...],"next":...}; pass next as ?before= for the next page
curl -s 'localhost:8080/api/conversations?channel=chat'    # only chat threads (or voice); the filter holds across pages
curl -s 'localhost:8080/api/conversations/<id>'            # one conversation with all its entries
curl -s -X DELETE 'localhost:8080/api/conversations/<id>'  # 204; 409 while its session or chat turn is still running; 404 when unknown
```

## Memory

The `brain` module (`modules/brain`) is Friday's long-term memory for the household. It holds small markdown pages about the people, places and projects in your life, plus one **profile** page about you and the household. There is one brain per household: Friday can't tell voices apart, so pages aren't per person.

- **What Friday sees.** Every voice session and chat turn starts with the profile, an index of the 50 most recently updated pages (name, type, aliases and a one-line hint) and short instructions. For anything in the index, or anything that might have been noted before, Friday calls `brain_recall`. That tool finds pages by exact name or alias plus a word search over names, aliases and text. The search ignores case and accents, and English and Dutch filler words.
- **Earlier conversations.** For what was said rather than what Friday knows ("what was that film we talked about last week?", "what did we watch on Tuesday?"), Friday calls `brain_recall_conversations`. It searches past voice and chat conversations by words and by whole days in `FRIDAY_TIMEZONE` (Friday resolves "last week" with `get_current_time`), and returns up to 5 conversations with short snippets around each match. It searches user and assistant text and each tool call's name and argument values. Tool results are never searched or returned. A question whose words are all too short or filler words ("TV") gets an error asking for other words. The conversation the question is asked in is left out. It only reaches back as far as `FRIDAY_CONVERSATION_RETENTION_DAYS` keeps conversations.
- **How it learns.** When you ask Friday to remember something, or share a lasting fact, it calls `brain_remember`. The tool appends a dated note (`- 2026-09-29: Birthday is 3 November`) under `## Notes` on the right page, creating the page if needed. `entity: "profile"` targets the profile. Friday never rewrites or deletes what is there; a correction is a newer note, and when two notes contradict, the newer one holds. The nightly pass (below) folds the notes into tidy page text. Notes are dated in `FRIDAY_TIMEZONE`.
- **Profile budget.** `BRAIN_PROFILE_TOKEN_BUDGET` (default 800, estimated as characters / 4) is a soft target. A "remember" on the profile is never refused; the portal shows the usage and marks an over-budget profile. The prompt context stays under 10000 characters by shortening the index first, and cutting the profile only as a last resort.
- **Curating.** `Brain` under Modules (`/m/brain`) lists the pages, with the profile pinned on top and a search box. A page shows its rendered text (raw HTML is shown as text, never run) with clickable `[[links]]` and its backlinks. Dangling links offer to create the page. `Edit` warns when the page changed since you opened it, for example because Friday just remembered something, and offers to discard your edits or overwrite. `History` has every revision with a line diff and `Restore this version`. Renaming keeps the old name as an alias so links keep working.
- **Forgetting.** `Delete` moves a page to "Recently deleted", from where it can be restored. `Delete forever` needs the page's name typed to confirm. It removes the page and its history, turns links to it on other pages into plain text, and tombstones its names, so Friday won't recreate the page on its own; you can still create it again yourself. Conversation transcripts and older revisions of other pages may still mention it. Memory is stored in plaintext in `friday.db`, next to the conversations.

### The nightly pass

The job `brain/nightly` (Jobs page; `BRAIN_NIGHTLY_CRON`, default `0 3 * * *` in `FRIDAY_TIMEZONE`, `off` disables it and needs a module reload) keeps the brain accurate without you doing it. It has two steps:

1. **Extract.** It reads the conversations that finished since the last run, oldest first and at most `BRAIN_NIGHTLY_MAX_CONVERSATIONS` (default 30) per run, and asks the text model for lasting facts. A resumed conversation is read again, but only its new entries count. Conversations with almost no user text are skipped without a model call. The first run works through the retained backlog over several nights.
   - **What it reads:** what you said or typed, Friday's answers, and which tools were called with which arguments. **Never tool results:** they are data fetched from elsewhere (a web page, an API) and may try to steer the model.
   - **What it notes:** only facts you stated or confirmed, still true in a month, about your household's world. "No notes" is the normal answer. It skips what is true only inside the conversation, what can be looked up live, moods, what only Friday said, what a page already holds, and forgotten names. A device name (`kitchen`) is never a person. Facts about "me" go on the profile.
   - **How:** exactly like `brain_remember`, as dated notes on the right page (created if needed), marked `extraction` with the conversation as source. A note is dated with the conversation's day, so a fact you already had Friday remember that day isn't added twice. Extraction never changes existing text.
2. **Consolidate.** When pages changed since the last tidy-up, one model call proposes a plan over the whole brain: rewrite a page (fold its notes into the text, dedupe, keep the newer fact, add `[[links]]`), create a page (for example to move detail off an over-budget profile), or merge two pages about the same thing (the absorbed page is deleted and its names become aliases). Every line a plan removes on purpose, like a superseded fact, must be declared with a reason. The plan is applied in one transaction, all or nothing, and refused when it targets a page that changed meanwhile, empties a page, renames or merges the profile, uses a forgotten or taken name, grows an over-budget profile, or **loses a line it didn't declare** (checked mechanically). A refused plan is sent back once with the reasons; otherwise nothing changes that night.

Changes apply directly, with no approval queue; everything is reviewable and revertible afterwards. The **`Nightly` tab** on `/m/brain` lists recent runs with their summary (`5 conversations (2 trivial), 4 notes; 3 pages rewritten, 1 merge, 2 lines dropped`). A run shows each page it changed with a diff from before to after, the dropped lines with their reasons, and its source conversations (marked gone once retention deleted them). `Revert` undoes a page as a new revision; reverting a merge also brings the absorbed page back, and a page edited after the run is left alone (open it and restore from its history). `Run now` on the Jobs page runs the pass immediately.

**Cost and model.** At most 30 extraction calls and 1 or 2 consolidation calls a night, on the `standard` tier (`FRIDAY_TEXT_MODEL`, default `gemini-flash-latest`), sharing `FRIDAY_LLM_CONCURRENCY` with everything else and logged without content. A stronger `FRIDAY_TEXT_MODEL` gives better merges and fewer refused plans when memory quality matters. Conversation content goes to the text model, as it does for chat.

**Measuring the prompts.** `modules/brain/test/fixtures/nightly/` holds synthetic conversations with facts that must be noted and content that must not be (a birthday said in passing, a correction, an injected tool result, a device-named voice session, a Dutch conversation, …) plus consolidation cases. `pnpm test` runs them against a fake model; to check the real one:

```sh
pnpm --filter @friday/module-brain eval             # every fixture against FRIDAY_TEXT_MODEL (reads GEMINI_API_KEY from .env)
pnpm --filter @friday/module-brain eval dutch       # one fixture
```

It prints `PASS` or `FAIL` per expectation and is never part of CI.

Over HTTP (the portal's API; see `modules/brain/src/routes.ts` and `src/nightly/review.ts`):

```sh
curl -s localhost:8080/api/modules/brain/pages               # {"profile":{"usedTokens","budgetTokens","overBudget"},"pages":[...],"deleted":[...]}
curl -s 'localhost:8080/api/modules/brain/runs?limit=14'     # nightly runs, newest first
curl -s localhost:8080/api/modules/brain/runs/<id>           # the pages a run changed, with before/after, dropped lines and sources
curl -s localhost:8080/api/modules/brain/pages/profile       # one page with revisions, links and backlinks
curl -s -X POST localhost:8080/api/modules/brain/pages -H 'content-type: application/json' -d '{"name":"Anouk","type":"person","aliases":["Noukie"]}'
```

## Chat

The portal's `Chat` page (under Assistant) is typed conversation with Friday, in threads you can come back to days later; voice conversations stay one-shot. Each message is one turn on a Gemini text model (not Live): core sends the chat system prompt, the thread's whole stored history (earlier tool calls and their results included, so Friday knows what it looked up and did) and the tools offered in chat, runs the tool calls the model asks for, and streams everything back as it happens: thought summaries (shown dimmed, not stored), the answer as it is written, and each tool call as it starts and settles. Answers are rendered as markdown with raw HTML disabled.

- **Threads.** A first message creates a `chat` conversation; later messages append to it and make it active again. A thread is never ended explicitly: it goes quiet after `FRIDAY_CONVERSATION_QUIET_MINUTES`, like any conversation, and background jobs see it then. It falls under the same retention.
- **Tools.** The same registry as voice, read fresh for every message (an MCP server added in the portal is available on the next message), minus voice-only tools. A tool that has not answered after `FRIDAY_CHAT_TOOL_TIMEOUT_MS` is reported to the model as timed out; it may still finish in the background. At most 10 rounds of tool calls per message.
- **Reliability.** Chat model calls share the `FRIDAY_LLM_*` concurrency bound, timeout and retry policy with module calls and log the same line under `[chat]`. Failures before any output are retried; a failure after text was streamed ends the turn with an error, and the partial answer is stored marked interrupted, so you can simply send again. Closing or reloading the page doesn't stop a turn: it finishes on the server and is recorded.

| Variable | Default | Purpose |
|---|---|---|
| `FRIDAY_CHAT_MODEL` | `FRIDAY_TEXT_MODEL` | Model chat turns run on. |
| `FRIDAY_CHAT_TOOL_TIMEOUT_MS` | `30000` | Longest wait for one tool call in a chat turn. |

Over HTTP, `POST /api/chat` takes `{ "text": "...", "conversationId": "<optional chat id>" }` and answers `text/event-stream` with the events `start`, `thinking`, `text`, `tool_call`, `tool_result`, then `done` or `error` (plus `: ping` comments every 15 s); `tool_call` and `tool_result` carry an `id` that pairs a result with its call. It answers 400 for an empty text, 413 for a body over 100 kB, 404 for an unknown or voice id, and 409 while that thread's previous turn still runs:

```sh
curl -sN -X POST localhost:8080/api/chat -H 'content-type: application/json' -d '{"text":"What time is it in Tokyo?"}'
```

## Configuration, storage and keys

Core keeps a SQLite database (`friday.db` in `FRIDAY_DATA_DIR`, a PVC in k8s) for these things:

- **Configuration values.** Every key a module declares shows up under Settings > Configuration as `set`, `pending` or `env`, split into two tabs, one table each with a row per key and chips for the modules that request it. The Configuration tab holds plain values (URLs, ids), shown in the row and stored as plain text. The Secrets tab holds keys the module declared `secret: true` (tokens, API keys); they are encrypted with `FRIDAY_MASTER_KEY` and never shown again after saving. Click a row to edit in a side panel. Stored values win over the environment; `Save and reload module` applies them without restarting Friday. Scope a value to one module or make it global. A module-scope value wins over the global one for that module; the Scope column shows `global +1` when a key is stored in more than one scope, and the side panel lists every stored copy with its own `Clear`, marking the ones that override the global value. Core requests `GEMINI_API_KEY` the same way (chip `core`, scope `core`): a key saved there wins over the environment and applies to the next voice session and model call, with no reload. Without a master key only secrets are disabled; plain configuration keeps working.
- **Remote module keys.** Settings > Remote modules issues a key per module id (shown once, stored hashed) and can revoke it, which disconnects the module immediately. `FRIDAY_MODULE_KEYS` remains a fallback.
- **Module storage.** Modules get `ctx.storage` (`get`, `set`, `delete`, `list`), a JSON key-value namespace per module. The test host provides an in-memory one.
- **Module tables.** Modules that declare `migrations` own tables named `<id>__*` (`-` in the id becomes `_`) and reach them through `ctx.db`, each on its own connection, which is refused everything outside that prefix. `module_schema` records each module's schema version, so a restart or reload runs only new migrations. Tables and versions stay when a module is disabled or removed. A module whose recorded version is newer than its code (after rolling back an image) fails to load instead of touching its data.

Modules can also add context to Friday's system prompts (`ctx.prompt.addContext`). The voice prompt is built when a session opens and kept for that session; the chat prompt is built when each turn starts. Module context follows the fixed prompt in module load order, and each module's contribution is cut to `FRIDAY_PROMPT_CONTEXT_MAX_CHARS` (default `12000`) characters.

The Modules page has a `Reload` button per in-process module, and `POST /api/modules/<id>/reload` does the same over HTTP. See `infra/README.md` for generating the master key and what happens if it is lost.

## Background jobs

Core runs scheduled work without a conversation. An in-process module declares a job in `init`:

```ts
ctx.jobs.schedule({
  name: "nightly",                 // job id: <module id>/nightly
  cron: "0 3 * * *",               // five-field cron in FRIDAY_TIMEZONE (default Europe/Amsterdam), or everyMs: 900_000
  timeoutMs: 10 * 60_000,          // optional
  run: async ({ signal, log, trigger }) => ({ summary: "deleted 12 conversations" }),
});
```

`ctx.jobs.trigger("nightly")` starts it on demand. Remote modules have no `ctx.jobs`. Behaviour:

- **Time zone.** Cron is evaluated in `FRIDAY_TIMEZONE`, resolved like core's other keys: the value saved for `core`, then the global one, then the environment. Unset or invalid means `Europe/Amsterdam`, the same fallback every module uses; an invalid value is logged as an error. Saving or clearing it in Settings > Configuration re-plans every cron job at once, no restart; on the day of the change a daily job can run twice or skip once, because its next run is planned afresh from that moment. The drawer saves `FRIDAY_TIMEZONE` globally by default (several requesters share it), which reaches cron and every module. A value saved for one module overrides the global one for that module: the drawer lists it under "Stored values" as overriding global, with a `Clear` for just that copy. Modules resolve the zone with `householdTimeZone(ctx.config, warn)` from `@friday/sdk`, which reads it per call and warns once per invalid value.
- **No overlap.** A run that comes due while the previous one is still going is recorded as `skipped`. After a timeout, reload or shutdown the handler's `signal` is aborted, and the job doesn't run again until the handler has actually settled.
- **Catch-up.** Core stores the due time of each job's last scheduled run. If one or more due times passed while Friday was down, the job runs once (trigger `catch-up`) `FRIDAY_JOB_CATCHUP_DELAY_MS` (30 s) after startup, then continues on its schedule. A new job waits for its first due time, and a quick module reload doesn't cause a catch-up.
- **History.** Every run is recorded with trigger (`schedule`, `catch-up`, `manual`, `module`), start, duration, outcome (`ok`, `failed`, `skipped`, `cancelled`), summary and error; the last `FRIDAY_JOB_HISTORY` (50) runs per job are kept. A failing run never affects the schedule or the server. Runs still going when Friday is killed are marked `cancelled` at the next start.

Settings > Jobs shows every job with its schedule, next run and last outcome, with the run history and `Run now` in a side panel. Over HTTP:

```sh
curl -s localhost:8080/api/jobs                                  # jobs, next run, running, last run
curl -s localhost:8080/api/jobs/<owner>/<name>/runs              # run history, newest first
curl -s -X POST localhost:8080/api/jobs/<owner>/<name>/run       # 202 { runId }, 409 when running, 404 unknown
```

## Text generation for modules

Work that happens outside a conversation (a nightly pass over transcripts, summaries, classification) can call a text model through `ctx.llm.generate`. Core owns the provider (Gemini `generateContent`, not Live), the key (the same `GEMINI_API_KEY`) and the model choice; modules pick a tier (`standard` or `fast`) and can ask for JSON validated against a schema. Failures are typed (`unavailable`, `invalid_output`, `blocked`, `invalid_request`, `cancelled`), calls take an abort signal, and transient errors are retried twice. Remote modules don't get it. See `packages/sdk/README.md` for the request shape and error handling.

| Variable | Default | Purpose |
|---|---|---|
| `FRIDAY_TEXT_MODEL` | `gemini-flash-latest` | Model for the `standard` tier. The alias follows Google's current Flash model; pin a name for stable behaviour. |
| `FRIDAY_TEXT_MODEL_FAST` | `FRIDAY_TEXT_MODEL` | Model for the `fast` tier. |
| `FRIDAY_LLM_CONCURRENCY` | `2` | Model calls in flight at once across all modules and chat turns; the rest wait in order. |
| `FRIDAY_LLM_TIMEOUT_MS` | `120000` | Per-attempt limit, unless a request sets `timeoutMs`. |
| `FRIDAY_LLM_MAX_RETRY_WAIT_MS` | `60000` | Longest wait before retrying a rate-limited call (HTTP 429). Core waits as long as Gemini asks, up to this; a longer requested wait or an exhausted daily quota fails at once. A request's `maxRetryWaitMs` overrides it. |

These calls cost money even when nobody is talking. Every call logs one line when it settles, with the module, the model (and the version that answered), token counts, latency, attempts and outcome, and never the prompt or the answer:

```
llm: [brain] gemini-flash-latest (gemini-3.8-flash) ok in=1834 out=212 think=640 2.4s (1 attempt)
llm: [brain] gemini-flash-latest (gemini-3.8-flash) ok in=1834 out=212 think=640 41.9s (2 attempts: 429 wait 39s)
```

## Remote modules

A module does not have to run inside Friday. `runRemote` from `@friday/sdk/remote` runs the same `defineModule` on another machine, dials `ws(s)://<friday>/ws/modules`, authenticates with a key, and serves its tools over MCP on that socket. While the connection is up its tools are registered as `<id>__<tool>` and listed under `/api/modules` with status `connected`; when the process stops or the network drops, they are removed. The remote reconnects with backoff (1 s to 30 s) and only gives up when Friday rejects the key.

Server side, create a key under Settings > Remote modules (or set `FRIDAY_MODULE_KEYS=<id>=<key>,...` as a fallback). Client side:

```ts
import { runRemote } from "@friday/sdk/remote";
import myModule from "./module.js";

const handle = runRemote(myModule, { url: "wss://friday.thewhite.nl/ws/modules", key: process.env.FRIDAY_MODULE_KEY! });
process.on("SIGINT", () => void handle.stop());
```

Gemini binds the tool list when a conversation starts, so **new or removed remote tools apply to the next conversation**, not the one already open. `remote/simracing` is the first remote module; see its README for running it on Windows.

## Jellyfin + Apple TV (Infuse)

Tools in `modules/media`:

- `list_episodes_to_watch` – Jellyfin Next Up or recently added episodes.
- `search_library` – find series and movies by name, with watch state.
- `get_next_episode` – for a series, picks the episode to continue with: partially watched → next unwatched → episode 1.
- `play_on_apple_tv` – wakes the Apple TV through Home Assistant, deep-links Infuse to the stream, and marks the item played in Jellyfin (Infuse does not report progress for URL streams).

"Let's continue Band of Brothers" chains search → next episode → play.

Setup:

1. Jellyfin: Dashboard → API Keys → create one. Set `JELLYFIN_URL`, `JELLYFIN_API_KEY`, and optionally `JELLYFIN_USER` (display name).
2. Home Assistant with the Apple TV integration set up. Create a long-lived access token (profile → Security) and set `HA_URL`, `HA_TOKEN`, and `HA_APPLE_TV_ENTITY` (the `media_player.*` entity of the Apple TV).
3. Infuse 7.6.2 or later on the Apple TV. Playback uses `infuse://x-callback-url/play?url=<jellyfin stream url>`; the Apple TV must be able to reach `JELLYFIN_URL` (override with `JELLYFIN_PUBLIC_URL`).

The stream URL embeds the Jellyfin API key, so keep this on your LAN.

## Travel time (TomTom)

`modules/travel` has one tool, `get_travel_time`, on voice and chat. "How long to drive to Schiphol?" or "when do I have to leave to be in Utrecht at nine?" It is car travel only.

- `origin` and `destination` are place names, addresses, points of interest, or a `lat,lon` pair (coordinates skip the lookup). The answer names the places TomTom actually matched, so a wrong match shows up ("to Schiphol-Rijk, 12 min").
- Without a time, it routes on live traffic. `departAt` or `arriveAt` (one, never both) routes on predicted traffic; `arriveAt` gives the latest departure that still makes it. A time without an offset is read in `FRIDAY_TIMEZONE`, and a time in the past is refused rather than quietly answered for now.
- The result has `durationText` ("1 hour 12 min") for Friday to read out, plus seconds, distance, traffic delay, and departure and arrival times.
- Place lookups are cached for 24 hours (a lookup that found nothing for 10 minutes); routes never are.

Setup: create a key at [developer.tomtom.com](https://developer.tomtom.com) with the **Routing** and **Places Search** products enabled (they are separate entitlements), and set `TOMTOM_API_KEY` in Settings > Configuration, then reload the `travel` module once. Changing the key later needs no reload; the next call uses it. A key without the right entitlement fails with TomTom's own "not allowed to access this endpoint" message, which is not the same as a wrong key. The module is `failed` until the key is set; leave it out with `FRIDAY_MODULES` if you don't want it. The key is sent as a query parameter (TomTom requires it) and is never logged.

## Voice devices

Voice satellites (the Voice PE below, and later others) are onboarded by trust on first use, under **Settings > Voice devices**:

1. **Flash the device.** On its first start it generates its own key, keeps it in flash (it survives power cuts, OTA updates and reflashes) and logs its fingerprint, for example `3f9a-c21e`. The Voice PE also shows it as the *Friday key fingerprint* sensor in Home Assistant.
2. **Wake it.** Friday doesn't know the device yet: it closes the connection with `4403 pending approval`, the LED ring shows the pending pattern, and the device appears under *Pending* with its id and fingerprint.
3. **Accept it.** Check that the fingerprint matches, then give it a label, its Home Assistant area (the area name or one of its aliases) and optional notes for Friday. From the next wake on it works.

What Friday does with it: a voice session from a device ends its system prompt with a short block naming the device and, when it has an area, telling Friday that requests naming no room, area or floor ("turn on the lights") apply to that area. The Home Assistant MCP server's tools take that area. Notes ("next to the TV", "the kids use this one") go in as written. Edits apply to the device's next session.

- **Replace key.** A factory-reset device comes back with a new key. It is rejected as pending and its row is marked; *Replace key* (showing old and new fingerprints) keeps its label, area and notes. The old key stops working at once. If the device connects with its old key in the meantime, it still has that key, so the replacement is dropped.
- **Revoke and delete.** *Revoke* closes the device's open session and rejects it from then on, whatever key it presents, without listing it as pending. *Delete* forgets it; its next attempt shows up as pending again. Conversations keep the device id.
- **Pending list.** One row per id, updated on each attempt (a different key starts the row's count and first-seen time over); rows go after 24 hours without an attempt, and at most 20 are kept. *Ignore* removes one until the device tries again.
- **API.** `GET /api/devices` (`{ devices, pending }`, never a key or hash), `POST /api/devices/pending/:id/accept` (`{ fingerprint, label?, area?, notes? }`), `DELETE /api/devices/pending/:id`, `PUT /api/devices/:id` (`{ label?, area?, notes? }`; label 1-80, area up to 80, notes up to 1000 characters), `POST /api/devices/:id/replace-key` (`{ fingerprint }`), `POST /api/devices/:id/revoke`, `DELETE /api/devices/:id`. Accept and replace answer 409 when the fingerprint no longer matches the key the device presents.

Keys are stored as SHA-256 hashes; the fingerprint is the first 8 hex characters of that hash, computed the same way on the device. Like the rest of the portal there is no login, so this relies on Friday being reachable only from a trusted network.

## Voice Preview Edition (ESP32)

`esphome/friday-voice-pe.yaml` turns a Home Assistant Voice Preview Edition into a press-to-talk Friday client. It is a thin fork of the official firmware: XMOS echo cancellation, I2S audio, DAC, LEDs, button, dial and mute switch stay as upstream; the Home Assistant voice pipeline, wake word and media player are removed and replaced by the `friday_client` component in `esphome/components/`, which speaks the `/ws/audio` protocol directly.

Prerequisites: ESPHome 2026.9 or newer on your machine (`brew install esphome` or `pip install esphome`), the Voice PE on the same LAN as the Friday server, and a USB-C cable for the first flash.

```sh
cd esphome
cp secrets.yaml.example secrets.yaml      # Wi-Fi, API key (openssl rand -base64 32), OTA password
$EDITOR friday-voice-pe.yaml              # check friday_url under substitutions (wss://friday.thewhite.nl/ws/audio)
esphome run friday-voice-pe.yaml          # first time over USB; afterwards it offers OTA
esphome logs friday-voice-pe.yaml         # tail the device log
```

Then onboard it (see [Voice devices](#voice-devices)): on first boot the device generates its key and logs `device friday-voice, key fingerprint xxxx-xxxx`, also shown as the **Friday key fingerprint** sensor in Home Assistant. Say "hey friday" once: the ring pulses amber (pending) and the device appears under Settings > Voice devices > Pending. Accept it with the same fingerprint, its Home Assistant area and any notes, and wake it again. The key stays in flash across power cuts, OTA updates and reflashes; only **Factory Reset** makes a new one, after which you *Replace key* in the portal.

The device id is the node name (`friday-voice`); set `device_id:` on `friday_client` to override it. Either way it must be 1 to 63 lowercase letters, digits and hyphens, the format Friday accepts; `esphome config` refuses any other. It connects over `wss://` and checks the server certificate against the bundled public CAs (Let's Encrypt included). For a local `pnpm dev` server set `friday_url` to `ws://<LAN IP>:8080/ws/audio`; that sends the key unencrypted, so only do it on a trusted network.

Usage: say **"hey friday"** (or press the top button) to start talking. A short chime confirms the wake word was heard. Friday ends the session itself after handling a request or when you say goodbye; the LEDs go off once its last words have played. While Friday is talking you can talk over it, or say "stop" and Friday ends the session; the button also stops it. The dial sets the speaker volume.

Wake word detection runs on the device with ESPHome's `micro_wake_word`; the microphone is always on for that purpose, but no audio leaves the device until the wake word fires. The "hey friday" model is a community model from [Custom_V2_MicroWakeWords](https://github.com/JohnnyPrimus/Custom_V2_MicroWakeWords) (Apache-2.0), pinned to a commit in the YAML. To use another phrase, change the `model:` line under `micro_wake_word` to an official name such as `hey_jarvis` or `okay_nabu`, or to another model URL, and reflash.

| LED ring | Meaning |
|---|---|
| Off (or your LED Ring colour) | Idle |
| Warm white twinkle | No Wi-Fi |
| Slow spin | Connecting to Friday |
| Fast spin | Listening |
| Reverse spin | Friday is speaking |
| Amber pulse | Friday has not accepted this device yet (pending); clears after 2 s |
| Red pulse | Error (server unreachable, connection lost, device revoked, or pressed while muted); clears after 2 s |
| Two red dots | Microphone muted |
| Red every third LED | XMOS voice kit failed to start |

Troubleshooting:

- **Red pulse right after pressing**: the device cannot reach `friday_url`, its certificate check failed, or Friday rejected it. The device log says which (`connection error`, or `unauthorized` for a revoked device or one without a key). Check `friday_url` and that the server is running. The server log prints `[friday-voice] session open` on success and `rejected: <code> <reason>` otherwise.
- **Amber pulse after waking it**: Friday has not accepted this device, or it presented a different key than the one accepted (after a factory reset). Accept it, or use *Replace key*, under Settings > Voice devices.
- **Red pulse while muted**: the side switch is on, or Mute is on in Home Assistant.
- **Choppy or late speech**: raise `buffer_duration` on the `friday_speaker` resampler (default 2000ms) at the cost of a little more delay before Friday starts talking.
- **Friday reacts to its own voice**: all playback must go through `friday_speaker`; anything bypassing the mixer defeats the XMOS echo cancellation.
- **Wake word misses or false triggers**: adjust `probability_cutoff` for `hey_friday` under `micro_wake_word` (lower is more sensitive), or try `channels: 0` for the engine's microphone. If the community model is not good enough, switch to `hey_jarvis`.
- **Friday interrupts itself during long replies**: it is hearing its own echo. Keep the client on microphone `channels: 1` (no automatic gain control) and leave `barge_in_delay` at 1500ms or raise it; on the server, `FRIDAY_VAD_START_SENSITIVITY=LOW` and `FRIDAY_VAD_PREFIX_MS=200` are the defaults. Set `FRIDAY_LOG_TRANSCRIPTS=1` to see what Gemini hears.
- **Session drops after Wi-Fi hiccups**: expected for now. The device shows the error pattern and returns to idle; the server cleans up via its ping timeout.

The component accepts `connect_timeout`, `drain_timeout`, `error_hold`, `send_chunk` (20ms to 1s, default 100ms) and `barge_in_delay` (default 1500ms) if you want to tune it. The device stays a normal ESPHome device in Home Assistant for OTA, logs, the Mute switch and the LED Ring light.

## MCP servers

Add MCP servers under **Settings > Configuration > MCP servers**. They are stored in `friday.db` and changes apply right away: saving a server reconnects just that server and shows whether it loaded, with the error when it didn't. Voice sessions that are already open keep their tools; the next session sees the change.

- **Transport**: streamable HTTP only (a `url` plus headers). Friday does not start MCP server processes; run a stdio-only server behind an HTTP bridge and add it by URL.
- **Tokens**: mark a header as *secret* (for example `Authorization: Bearer …` for Home Assistant). Secret values are encrypted with `FRIDAY_MASTER_KEY`, never shown again, and kept when you leave them blank while editing. Without a master key only plain values can be saved.
- **Tools** are registered as `<prefix>__<tool>` (the prefix defaults to the server name; owner `mcp:<server>` in `/api/modules`). Use the include and exclude lists to trim large servers, and scheduling to control how Gemini surfaces results.
- **API**: `GET/POST /api/mcp/servers`, `PUT/DELETE /api/mcp/servers/:name`, `POST /api/mcp/servers/:name/reconnect`. Secret values are never returned.

The portal has no login, so keep it on a trusted network: anyone who can reach it can add or change servers. Friday refuses API writes from other origins, so a web page you visit cannot do that through your browser.

`mcp.json` and `FRIDAY_MCP_CONFIG` are no longer read. When upgrading, re-enter each HTTP server from the old file in the portal, then delete the file (and, in k8s, the `friday-mcp` secret).

Keep the total tool count modest: Gemini reads every declaration and caps at 512.

## Transport

`WS /ws/audio` carries raw PCM both ways; see the protocol in `packages/core/src/transports/ws.ts`. The web UI and the Voice PE client speak the same protocol. Transports wrap `GeminiSession` (`packages/core/src/session.ts`), so tools and prompt behaviour are shared. A WebRTC transport can be added alongside it later.

- A voice device appends `?device=<id>` and sends its key as `Authorization: Bearer <key>` (never in the URL). Friday checks it before any Gemini session opens and closes a rejected connection at once: `4400 bad device` (malformed id or key), `4401 unauthorized` (no key, or the device is revoked), `4403 pending approval` (an unknown id or a different key, listed in the portal to accept; see [Voice devices](#voice-devices)), or `1011 internal error` when the device check itself fails. An accepted device is logged with the session, recorded as the device of its conversation (see [Conversations](#conversations)) and gets its room in the prompt. Without `?device=` no key is needed, as for the portal's Talk page. Unknown query parameters are ignored.
- Binary frames may be any size; batching 100 ms (3200 bytes) per frame is fine for microcontrollers.
- The server pings every `FRIDAY_WS_PING_MS` (default 20000) and drops connections that stop answering, which also closes the Gemini session. Set to `0` to disable.

Run `pnpm test` for the transport tests.

## Deploy

Every push to `main` builds `registry.thewhite.nl/friday/friday:<sha>` on the homelab runner and rolls it out to the `friday` namespace (`.github/workflows/deploy.yml`, manifest in `deploy/k8s.yaml`). Portal at `https://friday.thewhite.nl`; the Voice PE connects to `wss://friday.thewhite.nl/ws/audio` on the same TLS host (there is no plain-HTTP route). One-time bootstrap (namespace, secrets, registry user) is in `infra/README.md`.
