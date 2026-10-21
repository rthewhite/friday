/**
 * `/api/agents`: definitions (validated by parseAgent), the tools agents can be given, runs and their parked
 * actions. Fixed paths are added before `/:name`, since the router takes the first match (and parseAgent
 * reserves those names).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ToolRegistry } from "@friday/sdk";
import { readBody, sendJson, type NodeHandler, type Router } from "../router.js";
import { AgentInputError, parseAgent, resolveTools } from "./definition.js";
import { MAX_REQUEST, type AgentRuntime, type DecideResult } from "./runtime.js";
import { AgentExists, type AgentRunStore, type AgentStore, type StoredAgent } from "./store.js";

export interface AgentsApi {
  agents: AgentStore;
  runs: AgentRunStore;
  runtime: AgentRuntime;
  registry: ToolRegistry;
  /** The next scheduled run of an agent (its job), or null. */
  nextRun: (name: string) => string | null;
}

const MAX_BODY = 100_000;

export function mountAgentRoutes(router: Router, api: AgentsApi | undefined): void {
  const need = (handler: (api: AgentsApi, req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => void | Promise<void>): NodeHandler =>
    (req, res, params) => (api ? handler(api, req, res, params) : sendJson(res, { error: "agents are not available" }, 503));

  router
    .add("GET", "/api/agents", need((a, _req, res) => sendJson(res, { agents: a.agents.list().map((s) => entry(a, s)) })))
    .add("POST", "/api/agents", need(async (a, req, res) => {
      const body = await json(req, res);
      if (body === undefined) return;
      try {
        sendJson(res, entry(a, a.agents.create(parseAgent(body))), 201);
      } catch (e) {
        if (e instanceof AgentInputError) return sendJson(res, { error: e.message }, 400);
        if (e instanceof AgentExists) return sendJson(res, { error: e.message }, 409);
        throw e;
      }
    }))
    .add("GET", "/api/agents/tools", need((a, _req, res) => {
      const offered = new Set(a.registry.declarations("agent").map((d) => d.name));
      sendJson(res, { tools: a.registry.list().filter((t) => offered.has(t.name)) });
    }))
    .add("GET", "/api/agents/runs/:id", need((a, _req, res, { id }) => {
      const run = a.runs.get(id);
      if (!run) return sendJson(res, { error: "unknown run" }, 404);
      sendJson(res, { ...run, actions: a.runs.actions(id) });
    }))
    .add("POST", "/api/agents/runs/:id/cancel", need((a, _req, res, { id }) => {
      const run = a.runs.get(id);
      if (!run) return sendJson(res, { error: "unknown run" }, 404);
      if (!a.runtime.cancel(id)) return sendJson(res, { error: "the run is not running" }, 409);
      sendJson(res, { cancelling: true }, 202);
    }))
    .add("POST", "/api/agents/actions/:id/approve", need(async (a, _req, res, { id }) => decided(res, await a.runtime.approve(id))))
    .add("POST", "/api/agents/actions/:id/reject", need((a, _req, res, { id }) => decided(res, a.runtime.reject(id))))
    .add("GET", "/api/agents/:name", need((a, _req, res, { name }) => {
      const s = a.agents.get(name);
      if (!s) return sendJson(res, { error: `unknown agent "${name}"` }, 404);
      sendJson(res, entry(a, s));
    }))
    .add("PUT", "/api/agents/:name", need(async (a, req, res, { name }) => {
      if (!a.agents.get(name)) return sendJson(res, { error: `unknown agent "${name}"` }, 404);
      const body = await json(req, res);
      if (body === undefined) return;
      try {
        sendJson(res, entry(a, a.agents.update(parseAgent(body, name))!));
      } catch (e) {
        if (e instanceof AgentInputError) return sendJson(res, { error: e.message }, 400);
        throw e;
      }
    }))
    .add("DELETE", "/api/agents/:name", need(async (a, _req, res, { name }) => {
      if (!a.agents.get(name)) return sendJson(res, { error: `unknown agent "${name}"` }, 404);
      await a.runtime.stop(name);
      a.agents.delete(name);
      res.statusCode = 204;
      res.end();
    }))
    .add("POST", "/api/agents/:name/run", need(async (a, req, res, { name }) => {
      const body = await json(req, res);
      if (body === undefined) return;
      const request = (body as { request?: unknown }).request;
      if (request !== undefined && request !== null && typeof request !== "string") return sendJson(res, { error: "request must be text" }, 400);
      if (typeof request === "string" && request.length > MAX_REQUEST) return sendJson(res, { error: `request is longer than ${MAX_REQUEST} characters` }, 400);
      const r = a.runtime.start(name, "portal", request ?? undefined);
      if (!r.ok && r.reason === "unknown") return sendJson(res, { error: `unknown agent "${name}"` }, 404);
      if (!r.ok) return sendJson(res, { error: "the agent is already running", since: r.since, runId: r.runId }, 409);
      sendJson(res, { runId: r.run.id }, 202);
    }))
    .add("GET", "/api/agents/:name/runs", need((a, _req, res, { name }) => {
      if (!a.agents.get(name)) return sendJson(res, { error: `unknown agent "${name}"` }, 404);
      sendJson(res, { runs: a.runs.list(name) });
    }));
}

/** An agent as listed: its definition, unmatched patterns, and how it is doing. */
function entry(a: AgentsApi, s: StoredAgent) {
  return {
    ...s,
    unmatched: resolveTools(s, a.registry).unmatched,
    running: a.runtime.running(s.name) ?? null,
    nextRunAt: a.nextRun(s.name),
    lastRun: a.runs.last(s.name) ?? null,
    pendingActions: a.runs.pendingCount(s.name),
  };
}

function decided(res: ServerResponse, r: DecideResult): void {
  if (r.status === "ok") return sendJson(res, r.action);
  if (r.status === "missing") return sendJson(res, { error: "unknown action" }, 404);
  sendJson(res, { error: r.status === "expired" ? "the action expired" : "the action was already decided" }, 409);
}

/** The JSON body (empty = {}), or undefined after answering 400/413. */
async function json(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  let raw: string;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch {
    sendJson(res, { error: `body too large (limit ${MAX_BODY / 1000} kB)` }, 413);
    return undefined;
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    sendJson(res, { error: "invalid JSON" }, 400);
    return undefined;
  }
}
