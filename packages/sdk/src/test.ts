/**
 * Test host: run a module against an in-memory registry with no server, no
 * Gemini and no environment leakage. `import { createTestHost } from "@friday/sdk/test"`.
 */
import { assertConfig, createContext, prefixedLogger, type Env } from "./context.js";
import { RouteTable, type HttpMethod, type RouteRequest, type RouteResponse } from "./http.js";
import { validateJob, type JobOutcome, type JobSpec, type JobTrigger } from "./jobs.js";
import { checkRequest, LlmError, parseOutput, type LlmRequest, type ModuleLlm } from "./llm.js";
import { validateManifest, type FridayModule, type ModuleLogger } from "./module.js";
import { OAuthError, type ModuleOAuth } from "./oauth.js";
import { ToolRegistry, type CallOptions, type CallResult } from "./registry.js";
import type { ConversationChannel } from "./conversations.js";
import { MemoryStorage } from "./storage.js";
import { MemoryConversations } from "./conversations.js";
import { lazyDb, openModuleDb, type ModuleDatabase, type ModuleDb } from "./db.js";
import { PromptContext, type PromptChannel } from "./prompt.js";
import type { CallUser, RequestUser } from "./user.js";

export interface TestHostOptions {
  /** Configuration the module sees. Defaults to an empty environment, not `process.env`. */
  env?: Env;
  /** Capture module log output; defaults to a silent logger. */
  log?: ModuleLogger;
  /**
   * Fake text model behind `ctx.llm`: return the raw text the model would answer, or throw an `LlmError`.
   * Requests are checked and schema output validated as in core. Without it, calls reject with `unavailable`.
   */
  llm?: FakeLlm;
  /** Conversations the module sees as `ctx.conversations`; seed before init when the module reads them there. */
  conversations?: MemoryConversations;
  /**
   * Fake OAuth tokens behind `ctx.oauth`, per provider: a token, an `OAuthError` to reject with, or a function
   * returning either, called on every `ctx.oauth.token` call. A provider the manifest does not request rejects
   * with `not_granted`, as in core; a requested provider missing here rejects with `not_connected`.
   */
  oauth?: Record<string, FakeOAuth>;
  /**
   * The user behind route requests, tool calls and prompt rendering. Without it, route requests carry an admin test
   * user (core always sets one) and calls and prompts carry none. Each request, call and render can override it.
   */
  user?: RequestUser;
}

/** The user route requests carry when the test host has no `user` option. */
export const TEST_USER: RequestUser = { id: "test-user", name: "Test User", role: "admin" };

export type FakeOAuthValue = string | OAuthError;
export type FakeOAuth = FakeOAuthValue | (() => FakeOAuthValue | Promise<FakeOAuthValue>);

export type FakeLlm = (request: LlmRequest) => string | Promise<string>;

export interface TestResponse {
  status: number;
  body: unknown;
  contentType?: string;
}

/** A job the module scheduled, as the test host recorded it. */
export interface TestJob {
  name: string;
  cron?: string;
  everyMs?: number;
}

export interface TestJobRun {
  outcome: Extract<JobOutcome, "ok" | "failed">;
  summary?: string;
  error?: string;
}

export interface TestHost {
  tools: string[];
  /**
   * Call a tool; pass `{ channel }` to call it as that channel would (out-of-channel tools are unknown). The call
   * carries the host's `user` unless `opts` has a `user` key (`{ user: undefined }` calls without one).
   */
  call(name: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<CallResult>;
  /** Names of the tools offered in a channel. */
  toolsIn(channel: ConversationChannel): string[];
  registry: ToolRegistry;
  /** In-memory storage the module saw as `ctx.storage`. */
  storage: MemoryStorage;
  /** Requests that reached the fake model through `ctx.llm`, in call order. */
  llmRequests: LlmRequest[];
  /** In-memory conversations the module saw as `ctx.conversations`: `seed(...)`, then `markQuiet(id)` to fire `onQuiet`. */
  conversations: MemoryConversations;
  /** Registered module routes as `GET search`. */
  routes: string[];
  /**
   * Invoke a module route in memory. `path` is relative to the module mount and may carry a query string. The request
   * carries the host's `user` (else `TEST_USER`); `opts.user` overrides it, `null` sends none.
   */
  request(method: HttpMethod, path: string, body?: unknown, headers?: Record<string, string>, opts?: { user?: RequestUser | null }): Promise<TestResponse>;
  /** Jobs the module scheduled. No timers run; use `runJob`. */
  jobs: TestJob[];
  /** Run a scheduled job's handler once (trigger `manual`) and report how it settled. */
  runJob(name: string): Promise<TestJobRun>;
  /**
   * The module's `ctx.db`, on an in-memory database its migrations already ran on. Seed and inspect its
   * tables here; the prefix rules apply as in core.
   */
  db: ModuleDb;
  /** `ctx.oauth.token` calls per provider, including rejected ones. */
  oauthCalls: Record<string, number>;
  /**
   * The module's prompt context for a channel, rendered as core would (empty when it adds none), for the host's
   * `user` unless one is given (`null` renders without a user).
   */
  promptContext(channel: PromptChannel, user?: CallUser | null): string;
  dispose(): Promise<void>;
}

const silent: ModuleLogger = { log() {}, warn() {}, error() {} };

export async function createTestHost(module: FridayModule, opts: TestHostOptions = {}): Promise<TestHost> {
  const env = opts.env ?? {};
  const log = opts.log ?? silent;
  validateManifest(module.manifest);
  assertConfig(module.manifest, env);
  const registry = new ToolRegistry(log);
  const table = new RouteTable();
  const storage = new MemoryStorage();
  const conversations = opts.conversations ?? new MemoryConversations(log);
  const llmRequests: LlmRequest[] = [];
  const llm = opts.llm && fakeLlm(opts.llm, llmRequests);
  const id = module.manifest.id;
  const specs = new Map<string, JobSpec>();
  const running = new Set<string>();
  const jobs: TestJob[] = [];
  const runJob = async (name: string, trigger: JobTrigger): Promise<TestJobRun> => {
    const spec = specs.get(name);
    if (!spec) throw new Error(`job ${id}/${name} is not scheduled`);
    running.add(name);
    try {
      const r = await spec.run({ signal: new AbortController().signal, log: prefixedLogger(id, log), trigger });
      return { outcome: "ok", ...(typeof r?.summary === "string" ? { summary: r.summary } : {}) };
    } catch (e) {
      return { outcome: "failed", error: e instanceof Error ? e.message : String(e) };
    } finally {
      running.delete(name);
    }
  };
  const jobApi = {
    schedule(spec: JobSpec) {
      validateJob(id, spec, specs);
      specs.set(spec.name, spec);
      jobs.push({ name: spec.name, ...(spec.cron !== undefined ? { cron: spec.cron } : { everyMs: spec.everyMs }) });
    },
    trigger(name: string) {
      if (!specs.has(name)) throw new Error(`job ${id}/${name} is not scheduled`);
      if (running.has(name)) return { started: false };
      void runJob(name, "module");
      return { started: true };
    },
  };
  let database: ModuleDatabase | undefined;
  const open = () => (database ??= openModuleDb(":memory:", id));
  if (module.migrations?.length) open().migrate(module.migrations, prefixedLogger(id, log));
  const db = lazyDb(open);
  const prompts = new PromptContext({ log });
  const hostUser: CallUser | undefined = opts.user && { id: opts.user.id, name: opts.user.name };
  const oauthCalls: Record<string, number> = {};
  const oauth = fakeOAuth(module, opts.oauth ?? {}, oauthCalls);
  await module.init(createContext(module.manifest, { env, registry, log, storage, conversations, jobs: jobApi, http: { route: (method, path, handler) => table.add({ method, path, handler }) }, llm, db, prompt: prompts.forOwner(id), oauth }));
  return {
    tools: registry.names(module.manifest.id),
    call: (name, args, opts = {}) => registry.callTool(name, args, "user" in opts ? opts : { ...opts, user: hostUser }),
    toolsIn: (channel) => registry.declarations(channel).map((d) => d.name),
    registry,
    storage,
    llmRequests,
    conversations,
    routes: table.list().map((r) => `${r.method} ${r.path.replace(/^\//, "")}`),
    async request(method, pathWithQuery, body, headers = {}, ropts = {}) {
      const [path, qs = ""] = pathWithQuery.split("?");
      const hit = table.find(method, path);
      if (hit === null) return { status: 404, body: { error: "not found" } };
      if (hit === "method") return { status: 405, body: { error: "method not allowed" } };
      const req: RouteRequest = {
        method,
        path,
        query: new URLSearchParams(qs),
        headers,
        ...(ropts.user === null ? {} : { user: ropts.user ?? opts.user ?? TEST_USER }),
        json: async <T,>() => body as T,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")),
      };
      const out: TestResponse = { status: 200, body: undefined };
      let sent = false;
      const res: RouteResponse = {
        get sent() { return sent; },
        status(code) { out.status = code; return res; },
        json(b) { sent = true; out.body = b; out.contentType = "application/json"; },
        text(b, ct = "text/plain") { sent = true; out.body = b; out.contentType = ct; },
      };
      await hit.handler(req, res, hit.params);
      if (!sent) out.status = 204;
      return out;
    },
    jobs,
    runJob: (name) => runJob(name, "manual"),
    db,
    oauthCalls,
    promptContext: (channel, user) => prompts.render(channel, user === null ? undefined : (user ?? hostUser)),
    dispose: async () => {
      conversations.clearSubscriptions();
      prompts.clear(id);
      await module.dispose?.();
      database?.close();
      database = undefined;
    },
  };
}

/** Core's request rule (only providers the manifest requests), then the test's fake per provider. */
function fakeOAuth(module: FridayModule, fakes: Record<string, FakeOAuth>, calls: Record<string, number>): ModuleOAuth {
  const id = module.manifest.id;
  const requested = new Set((module.manifest.oauth ?? []).map((r) => r.provider));
  return {
    async token(provider) {
      calls[provider] = (calls[provider] ?? 0) + 1;
      if (!requested.has(provider)) throw new OAuthError("not_granted", `${id} does not request access to ${provider}`);
      const fake = fakes[provider];
      if (fake === undefined) throw new OAuthError("not_connected", `${provider} is not connected in this test host`);
      const value = typeof fake === "function" ? await fake() : fake;
      if (value instanceof OAuthError) throw value;
      return value;
    },
  };
}

/** Same checks and validation as core; no queue, retries or timeout. */
function fakeLlm(fake: FakeLlm, requests: LlmRequest[]): ModuleLlm {
  const cancelled = () => new LlmError("cancelled", "text generation was cancelled");
  return {
    async generate<T>(req: LlmRequest) {
      checkRequest(req);
      if (req.signal?.aborted) throw cancelled();
      requests.push(req);
      let text: string;
      try {
        text = await fake(req);
      } catch (e) {
        if (e instanceof LlmError) throw e;
        throw new LlmError("unavailable", e instanceof Error ? e.message : String(e), { cause: e });
      }
      if (req.signal?.aborted) throw cancelled();
      const model = `fake-${req.model ?? "standard"}`;
      const usage = { inputTokens: 0, outputTokens: 0 };
      return req.schema ? { text, json: parseOutput<T>(req.schema, text), model, usage } : { text, model, usage };
    },
  };
}
