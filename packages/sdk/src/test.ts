/**
 * Test host: run a module against an in-memory registry with no server, no
 * Gemini and no environment leakage. `import { createTestHost } from "@friday/sdk/test"`.
 */
import { assertConfig, createContext, prefixedLogger, type Env } from "./context.js";
import { RouteTable, type HttpMethod, type RouteRequest, type RouteResponse } from "./http.js";
import { validateJob, type JobOutcome, type JobSpec, type JobTrigger } from "./jobs.js";
import { checkRequest, LlmError, parseOutput, type LlmRequest, type ModuleLlm } from "./llm.js";
import type { FridayModule, ModuleLogger } from "./module.js";
import { ToolRegistry, type CallResult } from "./registry.js";
import { MemoryStorage } from "./storage.js";

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
}

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
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  registry: ToolRegistry;
  /** In-memory storage the module saw as `ctx.storage`. */
  storage: MemoryStorage;
  /** Requests that reached the fake model through `ctx.llm`, in call order. */
  llmRequests: LlmRequest[];
  /** Registered module routes as `GET search`. */
  routes: string[];
  /** Invoke a module route in memory. `path` is relative to the module mount and may carry a query string. */
  request(method: HttpMethod, path: string, body?: unknown, headers?: Record<string, string>): Promise<TestResponse>;
  /** Jobs the module scheduled. No timers run; use `runJob`. */
  jobs: TestJob[];
  /** Run a scheduled job's handler once (trigger `manual`) and report how it settled. */
  runJob(name: string): Promise<TestJobRun>;
  dispose(): Promise<void>;
}

const silent: ModuleLogger = { log() {}, warn() {}, error() {} };

export async function createTestHost(module: FridayModule, opts: TestHostOptions = {}): Promise<TestHost> {
  const env = opts.env ?? {};
  const log = opts.log ?? silent;
  assertConfig(module.manifest, env);
  const registry = new ToolRegistry(log);
  const table = new RouteTable();
  const storage = new MemoryStorage();
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
  await module.init(createContext(module.manifest, { env, registry, log, storage, jobs: jobApi, http: { route: (method, path, handler) => table.add({ method, path, handler }) }, llm }));
  return {
    tools: registry.names(module.manifest.id),
    call: (name, args) => registry.callTool(name, args),
    registry,
    storage,
    llmRequests,
    routes: table.list().map((r) => `${r.method} ${r.path.replace(/^\//, "")}`),
    async request(method, pathWithQuery, body, headers = {}) {
      const [path, qs = ""] = pathWithQuery.split("?");
      const hit = table.find(method, path);
      if (hit === null) return { status: 404, body: { error: "not found" } };
      if (hit === "method") return { status: 405, body: { error: "method not allowed" } };
      const req: RouteRequest = {
        method,
        path,
        query: new URLSearchParams(qs),
        headers,
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
    dispose: async () => void (await module.dispose?.()),
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
