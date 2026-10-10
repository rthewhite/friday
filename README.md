# Friday

Voice assistant on **Gemini 3.8 Live** (TypeScript / Node) built as a small core that hosts modules.

```
browser portal (Vue)   ── WebSocket PCM ──┐
                                          ├─► core ── Gemini Live (PCM 16k in / 24k out)
ESP32 / Voice PE       ── WebSocket PCM ──┘    │
ESP32 / Voice PE       ◄─ /ws/device (ring) ───┤   alerts: timers that ring their device
portal Chat page       ── /api/chat (SSE) ────►├── Gemini text model (chat turns, streamed, with tools)
                                               ├─► modules/builtin   time, end_conversation
                                               ├─► modules/media     Jellyfin + Apple TV
                                               ├─► modules/brain     long-term memory (pages, profile)
                                               ├─► modules/travel    driving time with traffic (TomTom)
                                               ├─► modules/calendar  iCloud calendar (CalDAV), Work calendar (intake)
                                               ├─► MCP servers       configured in the portal (HTTP)
                                               └─◄ remote modules    dial in over /ws/modules (e.g. remote/simracing)
```

The repo is a pnpm workspace:

| Package | Path | What |
|---|---|---|
| `@friday/sdk` | `packages/sdk` | The module contract (`defineModule`, `ModuleContext`, `ToolRegistry`) and a test host |
| `@friday/core` | `packages/core` | HTTP server, `/ws/audio`, `/ws/device`, `GeminiSession`, alerts and the timer tools, the chat engine (`/api/chat`), module host, MCP servers, serves the portal |
| `@friday/portal` | `packages/portal` | Vue 3 + Vite + Tailwind shell: Talk, Chat, Conversations, Modules, and module pages |
| `@friday/portal-ui` | `packages/portal-ui` | Design tokens, base components, `defineModuleUi` |
| `@friday/module-builtin` | `modules/builtin` | `get_current_time`, `end_conversation` |
| `@friday/module-media` | `modules/media` | Jellyfin library and Apple TV (Infuse) playback via Home Assistant |
| `@friday/module-brain` | `modules/brain` | Long-term memory: `brain_remember`, `brain_recall`, `brain_recall_conversations`, prompt context and the `/m/brain` page (see [Memory](#memory)) |
| `@friday/module-travel` | `modules/travel` | `get_travel_time`: driving time with live or predicted traffic via TomTom (see [Travel time](#travel-time-tomtom)) |
| `@friday/module-calendar` | `modules/calendar` | The iCloud calendar over CalDAV (list, create, and confirmed edits/deletes with undo) plus a read-only Work calendar from the intake, today's agenda in the prompt, and the `/m/calendar` page (see [Calendar](#calendar-icloud-and-work)) |
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
- If you stay silent for `FRIDAY_IDLE_TIMEOUT_MS` (default 8000) after Friday finishes a turn, the session closes. Set to `0` to disable. The timer is paused while a tool is still running. A session Friday opened to announce an alert (a timer going off) can't be ended by the model before you've said something: silence closes it with `ended: no answer`, after 8 seconds even when the timeout is disabled, and the alert rings again.

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

`scheduling` controls how Gemini surfaces the result: `INTERRUPT` (default), `WHEN_IDLE`, or `SILENT`; a handler can override it per call by returning a `scheduling` key. Returning an `endConversation: "<reason>"` key asks the session to close after the model's turn (this is how `end_conversation` works). Both keys are stripped before the result reaches Gemini. Calls run in the background so audio keeps flowing during slow tools. A tool is offered in voice and in chat unless it sets `channels` (`["voice"]` or `["chat"]`); `end_conversation` and the timer tools are voice-only, because a chat turn has no microphone to close and no device to ring. Modules whose `required` config is missing fail to load with a clear error while the rest of Friday starts; see `packages/sdk/README.md` for the full contract.

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

The `brain` module (`modules/brain`) is Friday's long-term memory for the household. It holds small markdown pages about the people, places and projects in your life, plus one **profile** page about you and the household. The profile is a short summary Friday always has at hand: who you are, who is in the household and your close relations (by name and relation, with a `[[link]]` to their page), and standing preferences. The detail lives on the pages: a person, place, project or organisation the brain knows more about than a name and a relation gets its own page, and a fact may be on both. There is one brain per household: Friday can't tell voices apart, so pages aren't per person.

- **What Friday sees.** Every voice session and chat turn starts with the profile, an index of the 50 most recently updated pages (name, type, aliases and a one-line hint) and short instructions. For anything in the index, or anything that might have been noted before, Friday calls `brain_recall`. That tool finds pages by exact name or alias plus a word search over names, aliases and text. The search ignores case and accents, and English and Dutch filler words.
- **Earlier conversations.** For what was said rather than what Friday knows ("what was that film we talked about last week?", "what did we watch on Tuesday?"), Friday calls `brain_recall_conversations`. It searches past voice and chat conversations by words and by whole days in `FRIDAY_TIMEZONE` (Friday resolves "last week" with `get_current_time`), and returns up to 5 conversations with short snippets around each match. It searches user and assistant text and each tool call's name and argument values. Tool results are never searched or returned. A question whose words are all too short or filler words ("TV") gets an error asking for other words. The conversation the question is asked in is left out. It only reaches back as far as `FRIDAY_CONVERSATION_RETENTION_DAYS` keeps conversations.
- **How it learns.** When you ask Friday to remember something, or share a lasting fact, it calls `brain_remember`. The tool appends a dated note (`- 2026-09-29: Birthday is 3 November`) under `## Notes` on the right page, creating the page if needed. A fact goes on the page of whoever or whatever it is about, also when you say it in the first person ("my wife Lisa teaches at…" goes on `Lisa`, with the relation in the fact); `entity: "profile"` is for facts about you or the household as a whole. Friday never rewrites or deletes what is there; a correction is a newer note, and when two notes contradict, the newer one holds. The nightly pass (below) folds the notes into tidy page text. Notes are dated in `FRIDAY_TIMEZONE`.
- **Profile budget.** `BRAIN_PROFILE_TOKEN_BUDGET` (default 800, estimated as characters / 4) is a soft target. A "remember" on the profile is never refused; the portal shows the usage and marks an over-budget profile. The prompt context stays under 10000 characters by shortening the index first, and cutting the profile only as a last resort.
- **Curating.** `Brain` under Modules (`/m/brain`) lists the pages, with the profile pinned on top and a search box. A page shows its rendered text (raw HTML is shown as text, never run) with clickable `[[links]]` and its backlinks. Dangling links offer to create the page. `Edit` warns when the page changed since you opened it, for example because Friday just remembered something, and offers to discard your edits or overwrite. `History` has every revision with a line diff and `Restore this version`. Renaming keeps the old name as an alias so links keep working.
- **Forgetting.** `Delete` moves a page to "Recently deleted", from where it can be restored. `Delete forever` needs the page's name typed to confirm. It removes the page and its history, turns links to it on other pages into plain text, and tombstones its names, so Friday won't recreate the page on its own; you can still create it again yourself. Conversation transcripts and older revisions of other pages may still mention it. Memory is stored in plaintext in `friday.db`, next to the conversations.

### The nightly pass

The job `brain/nightly` (Jobs page; `BRAIN_NIGHTLY_CRON`, default `0 3 * * *` in `FRIDAY_TIMEZONE`, `off` disables it and needs a module reload) keeps the brain accurate without you doing it. It has two steps:

1. **Extract.** It reads the conversations that finished since the last run, oldest first and at most `BRAIN_NIGHTLY_MAX_CONVERSATIONS` (default 30) per run, and asks the text model for lasting facts. A resumed conversation is read again, but only its new entries count. Conversations with almost no user text are skipped without a model call. The first run works through the retained backlog over several nights.
   - **What it reads:** what you said or typed, Friday's answers, and which tools were called with which arguments. **Never tool results:** they are data fetched from elsewhere (a web page, an API) and may try to steer the model.
   - **What it notes:** only facts you stated or confirmed, still true in a month, about your household's world. "No notes" is the normal answer. It skips what is true only inside the conversation, what can be looked up live, moods, what only Friday said, what a page already holds, and forgotten names. A device name (`kitchen`) is never a person. Facts about the speaker go on the profile; facts about a named other person, place, project or organisation go on that entity's page, also when said in the first person ("my sister Anouk…").
   - **How:** exactly like `brain_remember`, as dated notes on the right page (created if needed), marked `extraction` with the conversation as source. A note is dated with the conversation's day, so a fact you already had Friday remember that day isn't added twice. Extraction never changes existing text.
2. **Consolidate.** When pages changed since the last tidy-up, one model call proposes a plan over the whole brain: rewrite a page (fold its notes into the text, dedupe, keep the newer fact, add `[[links]]`), create a page, or merge two pages about the same thing (the absorbed page is deleted and its names become aliases). It keeps the profile a summary whatever the budget: detail the profile holds about a person, place, project or organisation moves (or is copied) to that entity's page, created if needed, and the profile keeps a short line with a `[[link]]`. Every line a plan removes on purpose, like a superseded fact, must be declared with a reason. The plan is applied in one transaction, all or nothing, and refused when it targets a page that changed meanwhile, empties a page, renames or merges the profile, uses a forgotten or taken name, grows an over-budget profile, or **loses a line it didn't declare** (checked mechanically: a removed line counts as kept when the result, or a page the line names that the plan leaves alone, still states it). A refused plan is sent back once with the reasons; otherwise nothing changes that night.
   - **When the guidance changes.** Consolidation remembers the version of its guidance it last applied. After an upgrade that changes it, the next run reconsiders the profile once, even when no page changed (an empty brain just records the new version). Click `Run now` on `brain/nightly` to do it right away instead of waiting for 03:00, then review the result in the `Nightly` tab.

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

The fixed prompt (`prompts` in `packages/core/src/config.ts`) tells Friday that you speak Dutch or English and to answer in the language you speak, unless you ask for another one. In voice sessions it also treats a whole utterance that seems to be in another language as misheard Dutch (names and titles don't count); typed chat is answered in whatever language you type.

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

## Calendar (iCloud and Work)

`modules/calendar` gives Friday your calendars from two sources, each optional: your iCloud calendar over CalDAV, and a read-only copy of your Work calendar (Outlook) that arrives through the homelab intake. The module loads when at least one of them has both of its keys. It discovers the iCloud account's calendars itself, so a calendar shared with you later just shows up.

iCloud setup:

1. Your Apple ID needs two-factor authentication (it almost certainly has it).
2. At [account.apple.com](https://account.apple.com), go to **Sign-In and Security > App-Specific Passwords**, add one called "Friday", and copy it (`abcd-efgh-ijkl-mnop`; it is shown once).
3. In Settings > Configuration, set `ICLOUD_USERNAME` to your Apple ID email and `ICLOUD_APP_PASSWORD` to that password, then reload the `calendar` module once.

Your normal Apple ID password does not work here; iCloud only accepts app-specific passwords for CalDAV. The password also opens mail and contacts over IMAP and CardDAV, so it is stored as a secret (encrypted, write-only), only ever sent to `*.icloud.com`, and never logged. Revoke it on its own by deleting "Friday" on the same page; changing your Apple ID password revokes every app-specific password at once. A rejected password makes the tools say so and point back here. A new one saved in the portal is used from the next request, without a reload. The module is `failed` until both keys of iCloud or of the intake are set; leave it out with `FRIDAY_MODULES` if you don't want it.

### Work calendar (Outlook, read-only)

Friday can't reach the employer's Outlook tenant, so a Power Automate flow sends a full copy of the work calendar every hour to the intake service on the homelab (`192.168.50.10:8081`). The flow uses "Get calendar view of events (V3)" for one month back to six months ahead, so every item is one meeting at one time (recurring meetings come already expanded, moved occurrences in their new slot), with UTC offsets.

Friday reads it with `POST $INTAKE_URL`, `Authorization: Bearer $INTAKE_KEY`, body `{"subject":"calendar"}`, from the `calendar/refresh` job every 5 minutes, so a new copy is in Friday about 5 minutes after the flow ran. In k8s both keys come from the `intake` Secret in the `friday` namespace (`envFrom` in `deploy/k8s.yaml`).

**Reading the intake removes what it returns.** Friday therefore stores the newest copy in friday.db before using it (it survives restarts), and a poll that finds nothing keeps that copy. Set `INTAKE_URL` and `INTAKE_KEY` in **one place only**: a laptop, a worktree or a second deployment with them set would take the deliveries meant for the deployed Friday. In `.env.example` they are commented out, with this warning. When several deliveries are waiting, the newest usable one wins and the others are dropped. A delivery whose events have no time offset (the old "Get events" format) or no valid events at all (an empty list included: the window always holds meetings, so it is a fault in the flow) is refused, the previous copy is kept, and the error shows in the portal. A copy of exactly 256 events is flagged, since that is where Outlook's connector cuts off.

The Work calendar is listed after the iCloud calendars as **Work** (or **Work (Outlook)** when iCloud also has a calendar called Work). It is read-only: Friday lists and searches it, includes it in the agenda and reports its meetings as overlaps, but refuses to create, change or delete there ("change it in Outlook"). How meetings show up:

- Times are shown in `FRIDAY_TIMEZONE`. All-day events keep the dates Outlook gives them.
- "Geannuleerd: …", "Canceled: …" and "Cancelled: …" meetings lose the prefix and get the status `cancelled`. Otherwise `showAs` gives `tentative`, `free` or `out of office`. Free and cancelled meetings never count as overlaps.
- Meeting links and "Microsoft Teams Meeting" become `online`; room names are kept, without their leading underscore (`Microsoft Teams Meeting; _Video Conference; SkyLounge` reads as `online, Video Conference, SkyLounge`).

The flow's window isn't in the copy, so when `calendar_list_events` reaches outside one month before to six months after the copy was received, the result says which dates the Work calendar covers, so that no work events there aren't read as free time. If you change the flow's window, change `COVERAGE` in `modules/calendar/src/work.ts` with it.

Reading and adding, on voice and chat:

- `calendar_list_events`: "What's on Thursday?", "When is the dentist?". Takes `from`/`to` (dates or date-times; a `to` date includes that whole day), an optional `query` (every word must appear in the title, location or notes) and `calendar` (by name). Without `from` it starts today; without `to` it covers 7 days, or 365 with a query. At most 366 days and 50 events per call. Recurring events are expanded, moved and cancelled occurrences included. Each event has a short `id` (like `e7k2`, valid for two hours after it was last listed), `start`/`end` in `FRIDAY_TIMEZONE` (dates with an inclusive end for all-day events), a readable `when`, `readOnly` with a reason for read-only calendars, invitations and the Work calendar, and a `status` for work meetings that have one. When iCloud can't be reached, the Work calendar's events still come back, with a note saying the iCloud calendars were left out.
- `calendar_create_event`: "Put the plumber in for Tuesday at nine". Takes `title`, `start`, and optionally `end` (an hour later by default; for all-day events the last day), `allDay` (implied by a date), `location`, `notes`, `calendar` (else the default), `repeat` (`daily`/`weekly`/`monthly`/`yearly`) and `repeatUntil`. It is created at once; the result has a `say` read-back and lists overlapping timed events, work meetings included (not free or cancelled ones), so Friday can mention a clash.

Changing and deleting go through a confirmation step that the model can't skip:

1. `calendar_update_event` (title, start, end, location, notes; an empty location or notes clears it; a new start keeps the duration) or `calendar_delete_event` take an `id` from a list result. They change nothing: they return a `before`/`after` preview, overlaps at the new time, and a `token`.
2. Friday reads the change back ("Move the dentist from 2 to 3 on Thursday?").
3. Only after a yes does it call `calendar_confirm` with the token. A token works once and for 5 minutes, and the write is conditional on the version that was previewed: if the event was changed on your phone in between, nothing is applied and Friday gets the current version instead.

For a recurring event Friday has to say whether it means only this occurrence (`scope: "occurrence"`) or the whole series (`"series"`), and asks you when that isn't clear. A whole series can only move to another time of day ("move the standup to 10"); changing its days is left to the Calendar app. Invitations organised by someone else, read-only calendars (subscriptions, some shared calendars) and work meetings are refused before a preview, with the reason.

Friday also knows today's and tomorrow's agenda without asking: every voice and chat prompt gets a short `## Calendar` section (all-day events first, then times, titles and locations, a work meeting's status like `(tentative)`, the calendar name like `[Work]` when more than one calendar is in the agenda, and "nothing planned" for an empty day). The iCloud events come from a cache that the `calendar/refresh` job (Settings > Jobs) fills every 5 minutes and right after each change Friday makes, and the work events from the stored copy, so opening a session never waits on iCloud or the intake. The job polls the intake and refreshes iCloud independently: one failing doesn't stop the other, and the job only fails when every configured source failed. "Today" is worked out when the prompt is built, so it rolls over at midnight. When iCloud is unreachable the section keeps the last events and says when they were fetched; before the first successful fetch it says the iCloud calendars are unavailable, so Friday doesn't claim you're free. The same goes for the Work calendar: unavailable before its first copy, and "last updated at …" once the copy is more than 3 hours old (the flow stopped delivering). A source that isn't configured isn't mentioned. It is cut at 2000 characters. Privacy: this puts your schedule in every conversation, including Talk-page sessions, which need no device key; turn "in agenda" off for calendars that shouldn't be there (see the portal page below).

Every change Friday makes is logged with the event's before and after state and where it came from (voice or chat, and the conversation). `calendar_undo` ("undo that", "no, put it back") reverts Friday's most recent change from the last 24 hours without asking; saying it again goes one change further back. Undo is conditional too: when the event was changed on your phone since, it refuses and says how the event is now. The log keeps the newest 500 changes.

The portal page `/m/calendar` shows what Friday sees and what it did. It is not a calendar app: there's no event grid and no editing.

- **Overview**: the connection, one row per source: iCloud (account, connected or the last error, when it was checked) and Work (up to date, out of date or the last poll's error, when the copy was received, how many events and which dates it covers, when the intake was last polled), or which keys are missing; a Refresh button that polls the intake, rediscovers calendars and refetches the agenda; the calendars, each with its colour, an Outlook badge for the Work calendar, a read-only badge where Friday can't write, and three settings: *Friday uses it* (off makes it invisible to every tool and the agenda), *In the agenda*, and *New events go here* (the default; without one, the first used, writable calendar); and the agenda text exactly as it goes into Friday's prompt.
- **Changes**: the change log, newest first, with where each change came from and before -> after, and an Undo button on every change that can still be undone (from the portal there is no 24-hour limit; it still refuses when the event changed since).

Routes, under `/api/modules/calendar/`: `GET status` (`icloud` and `work` per source, and each calendar's `source`), `PUT settings` (`{ calendars: { <id>: { use?, inAgenda? } }, defaultId? }`; 400 for unknown ids or a read-only or unused default), `GET agenda`, `GET changes?limit=` (default 50, max 200), `POST changes/:id/undo` (409 with the reason, and the current version when the event changed), `POST refresh`. None of them returns the password or `INTAKE_KEY`.

Times without an offset are household time, and every time Friday gets back is too. Travel time combines on its own: "when do I need to leave for the dentist?" is a list call plus `get_travel_time` to the event's location.

## Voice devices

Voice satellites (the Voice PE and the reSpeaker XVF3800 below) are onboarded by trust on first use, under **Settings > Voice devices**:

1. **Flash the device.** On its first start it generates its own key, keeps it in flash (it survives power cuts, OTA updates and reflashes) and logs its fingerprint, for example `3f9a-c21e`. The Voice PE also shows it as the *Friday key fingerprint* sensor in Home Assistant.
2. **Let it connect.** Right after joining Wi-Fi the device opens its control connection (`/ws/device`, see [Timers and alerts](#timers-and-alerts)); waking it does the same for a session. Friday doesn't know the device yet: it closes the connection with `4403 pending approval` (after a wake word the LED ring shows the pending pattern), and the device appears under *Pending* with its id and fingerprint.
3. **Accept it.** Check that the fingerprint matches, then give it a label, its Home Assistant area (the area name or one of its aliases) and optional notes for Friday. From the next wake on it works, and within a minute it shows as online.

What Friday does with it: a voice session from a device ends its system prompt with a short block naming the device and, when it has an area, telling Friday that requests naming no room, area or floor ("turn on the lights") apply to that area. The Home Assistant MCP server's tools take that area. Notes ("next to the TV", "the kids use this one") go in as written. Edits apply to the device's next session.

- **Replace key.** A factory-reset device comes back with a new key. It is rejected as pending and its row is marked; *Replace key* (showing old and new fingerprints) keeps its label, area and notes. The old key stops working at once. If the device connects with its old key in the meantime, it still has that key, so the replacement is dropped.
- **Status.** The dot shows *in a session* (a conversation is open), *online* (its control connection is open, so Friday can ring it), *offline*, or *revoked*. A device that stays offline while idle runs firmware without the control connection and can't ring timers.
- **Revoke and delete.** *Revoke* closes the device's open session and control connection, and rejects it from then on, whatever key it presents, without listing it as pending. *Delete* forgets it and cancels its timers; its next attempt shows up as pending again. Conversations keep the device id.
- **Pending list.** One row per id, updated on each attempt (a different key starts the row's count and first-seen time over); rows go after 24 hours without an attempt, and at most 20 are kept. *Ignore* removes one until the device tries again.
- **API.** `GET /api/devices` (`{ devices, pending }`, each device with `online` and `connected`, never a key or hash), `POST /api/devices/pending/:id/accept` (`{ fingerprint, label?, area?, notes? }`), `DELETE /api/devices/pending/:id`, `PUT /api/devices/:id` (`{ label?, area?, notes? }`; label 1-80, area up to 80, notes up to 1000 characters), `POST /api/devices/:id/replace-key` (`{ fingerprint }`), `POST /api/devices/:id/revoke`, `DELETE /api/devices/:id`. Accept and replace answer 409 when the fingerprint no longer matches the key the device presents.

Keys are stored as SHA-256 hashes; the fingerprint is the first 8 hex characters of that hash, computed the same way on the device. Like the rest of the portal there is no login, so this relies on Friday being reachable only from a trusted network.

## Timers and alerts

"Set a timer for five minutes for the eggs" on a voice device sets a timer and the conversation ends as usual; no Gemini session stays open while it counts down. When the timer is due, Friday starts talking on its own:

1. **Ring.** Friday sends `ring` over the device's control connection (`/ws/device`). The device opens an alert session (`/ws/audio?device=<id>&alert=<id>`), as if its wake word had been spoken.
2. **Announce.** The session opens with a short tone, then Friday says what went off ("your eggs timer is done"), in the language you set it in, and listens. Answer anything ("thanks", "stop") and the timer is done; "give me five more minutes" snoozes it. Friday can't end the session before you've reacted.
3. **Ring again.** If nobody answers, the session closes with `ended: no answer` and Friday rings again after `FRIDAY_ALERT_RING_INTERVAL_MS` (default 60000), up to `FRIDAY_ALERT_RINGS` times (default 5). After that the timer counts as *missed*.
4. **Fallback tone.** When the alert session can't open (Gemini unreachable, a bad key) or the device is muted, the device rings with its own tone until you press its button (the Mute button on the reSpeaker, which then leaves mute as it was), and gives up after five minutes.

A timer rings on the device it was set on. Several timers due at once are announced together. If the device is in a conversation, the ring waits until it ends; if it is offline (or Friday was down), it rings as soon as it can, but no ring starts later than `FRIDAY_ALERT_GRACE_MS` (default 600000) after the due time, and a timer that couldn't ring by then is *missed*. Timers are stored in `friday.db`, so they survive a restart.

- **Tools** (voice only, owned by core): `set_timer` (`seconds` 1-86400, `label`, `language` `nl`/`en`), `list_timers` (every device's timers with the seconds left), `cancel_timer` (by id or label; when it can't tell which, it cancels nothing and lists them) and `snooze_alert` (1-60 minutes, only in the session that announces it). A timer needs a voice device with current firmware: on the Talk page, in chat or on a device without a control connection `set_timer` explains why it can't.
- **Settings > Alerts** lists running timers with the time left and a *Cancel* action, and finished ones with their outcome; missed timers stand out.
- **API.** `GET /api/alerts` (`{ alerts }`: active first, then finished newest first, each with `id`, `kind`, `label`, `dueAt`, `target` `{ kind, id, label }`, `state`, `createdAt`, `finishedAt`, `rings`), `DELETE /api/alerts/:id` (cancel: 204, 404 unknown, 409 already finished).
- **Firmware.** Ringing needs the current `friday_client` on the device (see the device sections below). Older firmware keeps working for conversations; the device just shows as offline and can't have timers.

Recurring alarms (a weekday wake-up with a morning briefing) and phone notifications for timers set without a device are planned, not built.

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

Then onboard it (see [Voice devices](#voice-devices)): on first boot the device generates its key and logs `device friday-voice, key fingerprint xxxx-xxxx`, also shown as the **Friday key fingerprint** sensor in Home Assistant. Once on Wi-Fi it opens its control connection, so it appears under Settings > Voice devices > Pending right away (saying "hey friday" does the same, and the ring then pulses amber). Accept it with the same fingerprint, its Home Assistant area and any notes, and wake it again. The key stays in flash across power cuts, OTA updates and reflashes; only **Factory Reset** makes a new one, after which you *Replace key* in the portal.

The device id is the node name (`friday-voice`); set `device_id:` on `friday_client` to override it. Either way it must be 1 to 63 lowercase letters, digits and hyphens, the format Friday accepts; `esphome config` refuses any other. It connects over `wss://` and checks the server certificate against the bundled public CAs (Let's Encrypt included). For a local `pnpm dev` server set `friday_url` to `ws://<LAN IP>:8080/ws/audio`; that sends the key unencrypted, so only do it on a trusted network.

Usage: say **"hey friday"** (or press the top button) to start talking. A short chime confirms the wake word was heard. Friday ends the session itself after handling a request or when you say goodbye; the LEDs go off once its last words have played. While Friday is talking you can talk over it, or say "stop" and Friday ends the session; the button also stops it. The dial sets the speaker volume.

Timers (see [Timers and alerts](#timers-and-alerts)): while on Wi-Fi the device keeps a control connection to Friday, shown as the **Friday online** sensor in Home Assistant. When a timer set on it is due, Friday rings it: the device starts a session by itself, plays a tone and Friday's announcement, and listens for your answer; pressing the button during it also counts as an answer. When that session can't open (Friday or Gemini unreachable) or the microphone is muted (side switch or Mute in Home Assistant), the device rings with its own chime and the whole ring blinks warm white; press the button to stop it. It gives up after `ring_limit` (default 5 minutes). The control connection's url is `friday_url` with `/ws/audio` replaced by `/ws/device`; set `control_url:` on `friday_client` when your setup differs.

Wake word detection runs on the device with ESPHome's `micro_wake_word`; the microphone is always on for that purpose, but no audio leaves the device until the wake word fires. The "hey friday" model is a community model from [Custom_V2_MicroWakeWords](https://github.com/JohnnyPrimus/Custom_V2_MicroWakeWords) (Apache-2.0), pinned to a commit in the YAML. To use another phrase, change the `model:` line under `micro_wake_word` to an official name such as `hey_jarvis` or `okay_nabu`, or to another model URL, and reflash.

| LED ring | Meaning |
|---|---|
| Off (or your LED Ring colour) | Idle |
| Warm white twinkle | No Wi-Fi |
| Slow spin | Connecting to Friday |
| Fast spin | Listening |
| Reverse spin | Friday is speaking |
| Amber pulse | Friday has not accepted this device yet (pending); clears after 2 s |
| Warm white blinking | A timer rings on the device's own chime; the button stops it |
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
- **Friday online stays off, or the portal shows the device offline**: the control connection can't reach Friday. The log says why (`control connection lost, reconnecting in N s`, or a close code); it retries from 1 s up to once a minute. Timers can't be set on the device meanwhile.

The component accepts `connect_timeout`, `drain_timeout`, `error_hold`, `send_chunk` (20ms to 1s, default 100ms), `barge_in_delay` (default 1500ms), `control_url` and `ring_limit` (10s to 60min, default 5min) if you want to tune it. The device stays a normal ESPHome device in Home Assistant for OTA, logs, the Mute switch and the LED Ring light.

## reSpeaker XVF3800 (ESP32)

`esphome/friday-respeaker.yaml` turns a Seeed reSpeaker XVF3800 4-mic array with its XIAO ESP32-S3 into a wake-word Friday satellite, with the same `friday_client`, onboarding and LED patterns as the Voice PE. The XVF3800 does the echo cancellation, noise suppression, the Mute button and the speaker codec. The ESP32 controls it over I2C (`esphome/components/xvf3800/`) and low-pass filters its 48 kHz audio down to the 16 kHz Friday and the wake word need (`esphome/components/decimating/`). Both components have host tests: `esphome/test/run.sh` (plain C++17, not part of `pnpm test`).

The board has two USB-C ports. The **XIAO's** (on the ESP32 module) powers the whole board and is the one for flashing the ESP32 and reading logs. The **XVF3800's** is only needed for the one-time XVF3800 flash below.

**One-time XVF3800 flash.** The firmware needs the XVF3800's I2S master image 1.0.9 (48 kHz). Boards ship with the USB image, which doesn't answer on I2C. Flash it once with `dfu-util` (`brew install dfu-util`):

```sh
curl -LO https://github.com/respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY/raw/master/xmos_firmwares/i2s/respeaker_xvf3800_i2s_master_v1.0.9_48k.bin
md5 respeaker_xvf3800_i2s_master_v1.0.9_48k.bin     # must be b62766ccf8fbbaf924d0d13beace495b
# Safe mode: hold Mute while plugging the cable into the XVF3800's USB port, then
dfu-util -l                                           # lists the XVF3800
dfu-util -R -e -a 1 -D respeaker_xvf3800_i2s_master_v1.0.9_48k.bin
```

The image stays on the XVF3800 across power cuts and ESP32 reflashes. To go back to Seeed's USB firmware, flash an image from `xmos_firmwares/usb/` in the same repo (for example `respeaker_xvf3800_usb_dfu_firmware_v2.1.1.bin`) the same way.

**Flash the ESP32 and onboard it** over the XIAO's USB-C:

```sh
cd esphome
cp secrets.yaml.example secrets.yaml      # once; the same keys as the Voice PE
$EDITOR friday-respeaker.yaml             # check friday_url under substitutions
esphome run friday-respeaker.yaml         # first time over USB; afterwards it offers OTA
esphome logs friday-respeaker.yaml        # tail the device log
```

Onboarding is as for the Voice PE (see [Voice devices](#voice-devices)). The device id is `friday-respeaker`, and the fingerprint is in the log and in the **Friday key fingerprint** sensor. The **XVF3800 status** sensor shows `1.0.9` when all is well. If it shows `unsupported firmware x.y.z (needs 1.0.9)` or `not responding on I2C`, the wake word does nothing and the log says the same: flash the XVF3800 as above.

Usage:

- **Talking.** Say **"hey jarvis"**. A chime confirms it, and Friday ends the session itself as on the Voice PE. The board uses ESPHome's official `hey_jarvis` model because the community "hey friday" model missed most attempts on it; to change the phrase, swap the `model:` line under `micro_wake_word` (for example `okay_nabu`). Sessions start by wake word only; no button starts or stops one.
- **Mute.** The **Mute** button cuts the microphones in hardware and lights the red LED, and pressing it again unmutes. The **Mute** switch in Home Assistant does the same. While muted, the wake word does nothing. Mute survives restarts and power cuts.
- **Volume.** The **Volume** number in Home Assistant (0 to 100 %, default 60 %) sets the speaker volume and survives restarts.
- **Timers.** As on the Voice PE: Friday rings the device over its control connection (the **Friday online** sensor), and you answer by voice. When it rings on its own chime (Friday unreachable, or muted), press the **Mute** button to stop it; the press doesn't change mute, so a muted device stays muted.

The LED ring shows the same patterns as the Voice PE table above, warm white blinking for a timer ringing on the chime included, except the muted and voice-kit rows: the red LED shows mute, and when the XVF3800 isn't ready the ring stays dark.

Troubleshooting:

- **Wake word does nothing and the ring stays dark**: look at the XVF3800 status sensor or the log (above).
- **Friday mishears you from a distance**: the XVF3800's AGC (`agc: true` under `xvf3800`) is what lifts far speech; keep it on. Don't add `gain_factor`, because near speech already reaches full scale. Leave the wake word's `gain_factor` at 1 too: the XVF3800's audio is already loud, and more gain clips it. If the wake word misses or triggers on its own, tune `probability_cutoff` under its model.
- **Friday interrupts itself**: keep all playback on `friday_speaker` (the XVF3800 uses it as its echo reference) and raise `barge_in_delay`. If that isn't enough, try `agc: false` at the cost of far-field understanding.

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
- A device connection receives only audio and the control events `interrupted`, `turn_complete` and `closed`. The transcripts and tool activity (`user_text`, `bot_text`, `tool_call`, `tool_result`) go only to the browser, which shows them; a large tool result could otherwise exhaust a device's memory. The conversation record is the same either way.
- A device answering a ring adds `&alert=<id>`; when that alert isn't ringing on the device anymore, the socket is closed with `4410 alert gone` before any Gemini session.
- `WS /ws/device?device=<id>` is a device's control connection, authenticated exactly like a device's `/ws/audio` connection: JSON only, no audio and no Gemini session. Friday sends `{"type":"ring","data":{"alert":"<id>"}}` and `{"type":"stop","data":{"alert":"<id>"}}`; the device reports `{"type":"ringing_locally"|"acknowledged"|"unanswered","alert":"<id>"}`. A newer connection of the same device closes the older one with `4409 replaced`. See `packages/core/src/transports/device-ws.ts`.
- Binary frames may be any size; batching 100 ms (3200 bytes) per frame is fine for microcontrollers.
- The server pings every `FRIDAY_WS_PING_MS` (default 20000) and drops connections that stop answering, which also closes the Gemini session. Set to `0` to disable.

Run `pnpm test` for the transport tests.

## Deploy

Every push to `main` builds `registry.thewhite.nl/friday/friday:<sha>` on the homelab runner and rolls it out to the `friday` namespace (`.github/workflows/deploy.yml`, manifest in `deploy/k8s.yaml`). Portal at `https://friday.thewhite.nl`; the Voice PE connects to `wss://friday.thewhite.nl/ws/audio` on the same TLS host (there is no plain-HTTP route). One-time bootstrap (namespace, secrets, registry user) is in `infra/README.md`.
