# Design

## Context

See `proposal.md` (Why) for the motivation and `specs/llm-adapters/spec.md` for the behaviour. Today's text path:

```
  chat/engine.ts --+                              +-- generate() --> toGeminiParams
                   +-- tool-loop.ts --+           |
  agents/runtime --+                  +-- LlmService (queue, retries, timeout, log)
                                      |           |
  ctx.llm ----------------------------+           +-- stream()   --> toStreamParams
                                                  |
                                     TextModel = GeminiTextModel (llm/gemini.ts)
```

Gemini is visible beyond `gemini.ts` in five places:
- `tool-loop.ts` builds `Content[]` and sends the model's `Part`s back verbatim, which keeps thought signatures.
- `chat/history.ts` replays stored entries straight into `Content[]`, merging adjacent contents of the same role.
- `chat/engine.ts` and `agents/runtime.ts` pass `Content[]` and cast declarations to Gemini's `FunctionDeclaration`.
- `LlmService` reads Gemini errors: `classify` reads `status`, `rateLimitInfo` parses `RetryInfo` and `QuotaFailure` from the message, and `throwIfBlocked` uses `BLOCKING_FINISH`.
- The tool loop's `unfinished()` and the SDK's `parseOutput` compare Gemini finish reasons (`MAX_TOKENS`, `MALFORMED_FUNCTION_CALL`).

The test fake `test/fake-stream.ts` and roughly a dozen core tests produce or check Gemini `Content` and `Part`.

Constraints: no behaviour change on Gemini, no change to `packages/sdk` or any module, and voice (`session.ts`) is not touched.

## Goals / Non-Goals

**Goals:**
- A neutral core type set and one model interface, so that a third adapter later (Anthropic, for example) touches only `llm/`.
- The Gemini adapter sends byte-for-byte the requests core sends today. This is proven by tests that compare against the current request builders before they are removed.
- An OpenAI-compatible adapter that passes the same contract tests, ready for `llm-providers` to construct.

**Non-Goals:**
- Choosing a provider at runtime, or any configuration for one. `server.ts` keeps building only the Gemini adapter.
- `modules/brain/scripts/eval.ts`. It is a hand-run developer script that calls `@google/genai` directly, and it stays as it is. `llm-providers` can point it at the interface later.
- Storing provider data, such as thought signatures, in the conversation store. It lives only for one turn or run, as it does today.

## Decisions

### 1. Neutral types live in core (`packages/core/src/llm/types.ts`), not in the SDK

```ts
type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[]; providerData?: ProviderData }
  | { role: "tool"; callId: string; name: string; result: Record<string, unknown> };
interface ToolCall { id: string; name: string; args: Record<string, unknown> }
interface ProviderData { adapter: "gemini" | "openai"; value: unknown }

interface ChatRequest {
  model: string; system?: string; messages: ChatMessage[];
  tools?: FunctionDeclaration[];          // the SDK's own type, unchanged
  schema?: JsonSchema; temperature?: number; maxOutputTokens?: number; thoughts?: boolean;
}
type StreamChunk = { kind: "text" | "thought"; text: string } | { kind: "call"; call: ToolCall };
interface ModelEnd {                       // the stream's return value, and part of generate's result
  finish: "stop" | "length" | "malformed_call" | "other"; providerReason?: string;
  model: string; usage: Required<LlmUsage>;
  message: Extract<ChatMessage, { role: "assistant" }>;   // the model's turn, to send back as is
}
interface ChatModel {
  generate(req: ChatRequest, o?: { signal?: AbortSignal }): Promise<ModelEnd>;   // message.text = answer
  stream(req: ChatRequest, o?: { signal?: AbortSignal }): AsyncGenerator<StreamChunk, ModelEnd>;
}
```

- Modules never see these types. `ctx.llm` keeps the SDK's `LlmRequest`, and `LlmService` maps its `role: "model"` to `assistant`. Putting the types in the SDK would make them a contract with modules for no reason. `document-store` can add a file part to `ChatMessage` here later.
- **The stream returns the assembled assistant message.** Chunks no longer carry a provider `Part`. The tool loop stops collecting parts and pushes `end.message`. The Gemini adapter puts the turn's non-thought parts in `providerData` (the same parts the loop collects today), so the turn goes back verbatim. The OpenAI adapter needs no provider data. *Alternative:* keeping a provider part on every chunk. Rejected, because it leaks the provider's format into the loop again.
- `generate` returns the same `ModelEnd`, so both calls share one result shape.
- **Tool declarations stay in the SDK's form** (`parameters` or `parametersJsonSchema`). The Gemini adapter passes them on as it does today. Only the OpenAI adapter converts them. *Alternative:* converting everything to JSON Schema in core. Rejected, because it would change what Gemini receives.

### 2. Adapters throw one neutral `ProviderError`; `LlmService` acts only on that

```ts
class ProviderError extends Error {
  kind: "rate_limited" | "transient" | "invalid_request" | "failed";
  reason: string;          // for the log: "429", "503", "network"
  waitMs?: number; quota?: string; daily?: boolean;
}
```

- The Gemini adapter takes over `classify`, `rateLimitInfo`, the daily-quota check and `BLOCKING_FINISH`, with unchanged logic. `LlmService` keeps the retry policy and the messages. Its `classify` becomes a switch on `ProviderError.kind`, so log lines and error messages stay identical.
- **Blocked is not a `ProviderError`.** An adapter throws `LlmError("blocked", …, { reason })` directly, as `throwIfBlocked` does today. `LlmService` already never retries an `LlmError`.
- **Missing keys:** the Gemini adapter keeps throwing `LlmError("unavailable", "GEMINI_API_KEY is not configured")`.
- **Finish reasons are neutral from the adapter onwards.** `unfinished()` in the tool loop switches on `length`, `malformed_call` and `other` (with `providerReason`), keeping today's messages. For `parseOutput`, `LlmService` passes `"MAX_TOKENS"` when `finish` is `length`, so the SDK helper and the test host stay untouched. *Alternative:* teaching `parseOutput` about `length`. That's a small SDK change. Deferred unless a second caller needs it.

### 3. Tool call ids: from the provider, otherwise made up, and prefixed so they never clash

- During a turn or run, a call uses the provider's id when it gives one (OpenAI always does, Gemini sometimes does). Otherwise the adapter makes one up: `c<n>`, counting within the call.
- On replay, `chat/history.ts` gives each stored tool entry the id `h<seq>`, from the entry's `seq`. Replayed and live ids can therefore never clash within one request.
- The Gemini adapter sends an id in `functionCall` and `functionResponse` only when Gemini supplied one. Today's requests carry none, so nothing changes for Gemini.
- `LoopCall` keeps its numeric `id` for bookkeeping in the loop and gains `callId: string`.

### 4. History becomes neutral; the Gemini adapter does the merging

`toMessages(entries)` gives one `user` message per user entry and one `assistant` text message per assistant entry. Each tool entry becomes an `assistant` message with one call, followed by its `tool` message. The `{ truncated, partial }` and `{ error: "no result" }` rules stay in `history.ts`.

Merging moves into the Gemini adapter, with the same rules as `toContents` today: "a model turn holds its text and the call after it; user text and function responses stay apart". So Gemini receives the same `Content[]`. The OpenAI adapter doesn't merge. Its format allows consecutive assistant and tool messages.

### 5. The OpenAI-compatible adapter is our own `fetch` client, with no `openai` package

- It follows the pattern of the CalDAV and Spotify clients: `fetch` can be injected, and `{ baseUrl, apiKey?: string | (() => string | undefined) }`. `apiKey` is resolved on each call, like Gemini's, so `llm-providers` can hand it a key from the store.
- *Alternative:* the `openai` package. Rejected. It's a large dependency built for OpenAI itself. Its retries would have to be switched off so they don't stack with ours, and its types tempt leaking past the adapter again.
- **Requests** follow the spec. Two choices the spec leaves open:
  - `max_tokens` for `maxOutputTokens`, because it's what Ollama, vLLM and llama.cpp accept. OpenAI's own newer models want `max_completion_tokens`, which `llm-providers` can add as a per-model setting.
  - `response_format: { type: "json_schema", json_schema: { name: "output", schema, strict: false } }`. Strict mode needs schema rules that our schemas don't follow, and `LlmService` validates the output anyway.
- **Redirects are refused** (`redirect: "error"`), so a bearer key never follows a redirect. Core does the same for the intake.
- **Streaming:** a small server-sent-events line parser reads `data:` lines until `[DONE]`.
  - Text deltas are yielded as they arrive.
  - `tool_calls` deltas are gathered by `index`: the id and name from the first delta, then the argument fragments joined. They are parsed and yielded when the stream finishes. Some servers, such as Ollama, send a whole call in one delta, and this handles that too.
  - If any call's arguments are not valid JSON, no calls are yielded and the call ends with `malformed_call`. That matches how Gemini reports a malformed call, so the loop's handling stays the same. Empty arguments become `{}`.
  - Finish reasons map as follows: `stop` and `tool_calls` to `stop`, `length` to `length`, `content_filter` to blocked, anything else to `other`. A stream that ends with `[DONE]` but without a finish reason counts as `stop`.
  - Usage comes from the last chunk that has `usage` (`stream_options: { include_usage: true }`), and is 0 otherwise.
- **Errors:**
  - The status mapping follows the spec. 401 and 403 become `failed`, which is not retried.
  - `Retry-After` can be seconds or an HTTP date. `retry-after-ms` is used when present.
  - `daily` is never set, because the format has no way to say it.
  - A failed `fetch` (TypeError) becomes `transient` with the reason `network`.
  - Messages include the server's `error.message`, cut to 200 characters, with any occurrence of the key replaced.

### 6. Tests: compare with today's requests first, then one contract suite for both adapters

1. **Golden requests, before any code moves.** Fixtures capture what today's `toGeminiParams`, `toStreamParams` and `toContents` produce for the existing chat-history, tool-loop and llm test inputs. These include thought signatures, truncated results, adjacent merging, schema and thought settings. The new Gemini adapter must produce the same parameters from the neutral request.
2. **Contract suite** (`test/llm-adapter-contract.ts`). One set of cases runs per adapter, through a small harness that scripts that provider's raw responses: stubbed `generateContent` and `generateContentStream` for Gemini, an injected `fetch` that returns JSON or a server-sent-events body for OpenAI. The cases cover text, thoughts, a tool round trip with ids, parallel calls, arguments in pieces, each finish reason, usage present and absent, 429 with a wait, 503, network, 401, blocked, and a schema request.
3. **Through to the caller.** A chat-engine test and an `LlmService.generate` test run on the OpenAI adapter over the fake `fetch`, matching the spec's "on another adapter" scenarios.
4. `test/fake-stream.ts` switches to neutral chunks and a neutral `ModelEnd`. Tests that checked `Content` in requests check `ChatMessage`s instead. The Gemini wire format is checked only in the adapter tests.
5. Before merging: run `chat-live` and `test:live` by hand against Gemini once.

### 7. Wiring

`server.ts` builds `new GeminiAdapter(geminiKey)` where it builds `GeminiTextModel` today, and nothing else changes. Nothing in production code builds the OpenAI adapter yet. It's exported from `llm/` for `llm-providers`.

## Risks / Trade-offs

- [The refactor subtly changes what Gemini receives (merging, thought signatures, ids)] → Golden request tests written before the move (decision 6.1), plus a live run by hand before merging.
- [OpenAI-compatible servers differ (`stream_options`, `json_schema` support, how tool calls are streamed)] → Tool call deltas are gathered whether they come whole or in pieces, and missing usage is 0. In this change it's only tested against fakes. A real server is first exercised in `llm-providers`, where a server that rejects a field can get a per-model setting.
- [Missing usage means an agent's `maxTokens` budget never runs out on such a server] → Not reachable in this change. `llm-providers` must decide this, for example by requiring usage for models that agents may use. Recorded there.
- [Interface shaped by only two providers] → Both differ a lot: Gemini's parts and signatures versus OpenAI's messages and ids. `providerData` is the escape hatch for a third provider.
- [`document-store` also changes `module-llm` and `LlmService`] → Whichever merges second rebases. If this merges first, file parts become a `ChatMessage` part here, instead of a Gemini `Part`.

## Migration Plan

This is a code-only refactor. No migration, configuration or environment changes. A normal deploy, and rollback means redeploying the previous image. Not risky by the definition in `CLAUDE.md`.
