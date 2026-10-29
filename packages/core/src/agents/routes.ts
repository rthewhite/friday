/**
 * `/api/agents`: definitions (validated by parseAgent), the tools agents can be given, runs and their parked
 * actions. Fixed paths are added before `/:name`, since the router takes the first match (and parseAgent
 * reserves those names).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CallUser, ToolRegistry } from "@friday/sdk";
import { requestUser } from "../auth/auth.js";
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

/** The user who made the request, as the runtime records them. */
const callUser = (req: IncomingMessage): CallUser | undefined => {
  const u = requestUser(req);
  return u && { id: u.id, name: u.name };
};

/**
 * Agents are private to their creator, admins included: anyone else's agent, run or action is answered 404, like an
 * unknown one, and left out of every listing.
 */
export function mountAgentRoutes(router: Router, api: AgentsApi | undefined): void {
  const need = (handler: (api: AgentsApi, req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => void | Promise<void>): NodeHandler =>
    (req, res, params) => (api ? handler(api, req, res, params) : sendJson(res, { error: "agents are not available" }, 503));
  const own = (a: AgentsApi, req: IncomingMessage, name: string | undefined) => (name === undefined ? undefined : a.agents.getOwn(name, requestUser(req)?.id));
  const unknownAgent = (res: ServerResponse, name: string) => sendJson(res, { error: `unknown agent "${name}"` }, 404);
  /** The run if it belongs to one of the requester's agents. */
  const ownRun = (a: AgentsApi, req: IncomingMessage, id: string) => {
    const run = a.runs.get(id);
    return run && own(a, req, run.agent) ? run : undefined;
  };
  const ownAction = (a: AgentsApi, req: IncomingMessage, id: string) => {
    const action = a.runs.action(id);
    return action && own(a, req, action.agent) ? action : undefined;
  };

  router
    .add("GET", "/api/agents", need((a, req, res) => {
      const me = requestUser(req);
      sendJson(res, { agents: me ? a.agents.list(me.id).map((s) => entry(a, s)) : [] });
    }))
    .add("POST", "/api/agents", need(async (a, req, res) => {
      const body = await json(req, res);
      if (body === undefined) return;
      const me = requestUser(req);
      if (!me) return sendJson(res, { error: "agents belong to a user; log in first" }, 401);
      try {
        sendJson(res, entry(a, a.agents.create(parseAgent(body), me.id)), 201);
      } catch (e) {
        if (e instanceof AgentInputError) return sendJson(res, { error: e.message }, 400);
        if (e instanceof AgentExists) return sendJson(res, { error: e.message }, 409);
        throw e;
      }
    }))
    .add("GET", "/api/agents/tools", need((a, req, res) => {
      const offered = new Set(a.registry.declarations("agent", callUser(req)).map((d) => d.name));
      sendJson(res, { tools: a.registry.list().filter((t) => offered.has(t.name)) });
    }))
    .add("GET", "/api/agents/runs/:id", need((a, req, res, { id }) => {
      const run = ownRun(a, req, id);
      if (!run) return sendJson(res, { error: "unknown run" }, 404);
      sendJson(res, { ...run, actions: a.runs.actions(id) });
    }))
    .add("POST", "/api/agents/runs/:id/cancel", need((a, req, res, { id }) => {
      const run = ownRun(a, req, id);
      if (!run) return sendJson(res, { error: "unknown run" }, 404);
      if (!a.runtime.cancel(id)) return sendJson(res, { error: "the run is not running" }, 409);
      sendJson(res, { cancelling: true }, 202);
    }))
    .add("POST", "/api/agents/actions/:id/approve", need(async (a, req, res, { id }) => {
      if (!ownAction(a, req, id)) return sendJson(res, { error: "unknown action" }, 404);
      decided(res, await a.runtime.approve(id, callUser(req)));
    }))
    .add("POST", "/api/agents/actions/:id/reject", need((a, req, res, { id }) => {
      if (!ownAction(a, req, id)) return sendJson(res, { error: "unknown action" }, 404);
      decided(res, a.runtime.reject(id, callUser(req)));
    }))
    .add("GET", "/api/agents/:name", need((a, req, res, { name }) => {
      const s = own(a, req, name);
      if (!s) return unknownAgent(res, name);
      sendJson(res, entry(a, s));
    }))
    .add("PUT", "/api/agents/:name", need(async (a, req, res, { name }) => {
      if (!own(a, req, name)) return unknownAgent(res, name);
      const body = await json(req, res);
      if (body === undefined) return;
      try {
        sendJson(res, entry(a, a.agents.update(parseAgent(body, name))!));
      } catch (e) {
        if (e instanceof AgentInputError) return sendJson(res, { error: e.message }, 400);
        throw e;
      }
    }))
    .add("DELETE", "/api/agents/:name", need(async (a, req, res, { name }) => {
      if (!own(a, req, name)) return unknownAgent(res, name);
      await a.runtime.stop(name);
      a.agents.delete(name);
      res.statusCode = 204;
      res.end();
    }))
    .add("POST", "/api/agents/:name/run", need(async (a, req, res, { name }) => {
      if (!own(a, req, name)) return unknownAgent(res, name);
      const body = await json(req, res);
      if (body === undefined) return;
      const request = (body as { request?: unknown }).request;
      if (request !== undefined && request !== null && typeof request !== "string") return sendJson(res, { error: "request must be text" }, 400);
      if (typeof request === "string" && request.length > MAX_REQUEST) return sendJson(res, { error: `request is longer than ${MAX_REQUEST} characters` }, 400);
      const r = a.runtime.start(name, "portal", request ?? undefined);
      if (!r.ok && r.reason === "unknown") return unknownAgent(res, name);
      if (!r.ok) return sendJson(res, { error: "the agent is already running", since: r.since, runId: r.runId }, 409);
      sendJson(res, { runId: r.run.id }, 202);
    }))
    .add("GET", "/api/agents/:name/runs", need((a, req, res, { name }) => {
      if (!own(a, req, name)) return unknownAgent(res, name);
      sendJson(res, { runs: a.runs.list(name) });
    }));
}

/** An agent as listed: its definition, unmatched patterns, and how it is doing. */
function entry(a: AgentsApi, s: StoredAgent) {
  return {
    ...s,
    unmatched: resolveTools(s, a.registry, s.createdBy ?? undefined).unmatched,
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
