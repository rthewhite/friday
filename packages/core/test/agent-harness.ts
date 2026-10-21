/** An agent runtime on an in-memory database, a fake model and a registry with a few recorded tools. */
import { ToolRegistry, type ToolCallContext } from "@friday/sdk";
import { parseAgent } from "../src/agents/definition.js";
import { AgentRuntime, type AgentRuntimeOptions } from "../src/agents/runtime.js";
import { AgentRunStore, AgentStore } from "../src/agents/store.js";
import type { LlmService } from "../src/llm/service.js";
import { setup } from "./conversation-fixtures.js";
import { fakeStream, type Round } from "./fake-stream.js";

export const quiet = { log() {}, warn() {}, error() {} };

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  call: ToolCallContext;
}

export function agentHarness(rounds: Round[], o: Partial<AgentRuntimeOptions> & { llm?: Pick<LlmService, "streamCall"> } = {}) {
  const { db, store: conversations, clock } = setup();
  const registry = new ToolRegistry(quiet);
  const calls: ToolCallRecord[] = [];
  const tool = (name: string, result: (args: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>> = () => ({ ok: true }), channels?: ("voice" | "chat" | "agent")[]) =>
    registry.add(name.includes("__") ? `mcp:${name.split("__")[0]}` : "test", {
      name,
      description: `${name} tool`,
      ...(channels ? { channels } : {}),
      handler: (args: Record<string, unknown>, call: ToolCallContext) => (calls.push({ name, args, call }), result(args)),
    });
  const agents = new AgentStore(db, clock.now);
  const runs = new AgentRunStore(db, clock.now);
  const stream = fakeStream(...rounds);
  const runtime = new AgentRuntime({
    agents,
    runs,
    registry,
    conversations,
    llm: o.llm ?? stream.llm,
    model: "text-model",
    timezone: () => "Europe/Amsterdam",
    toolTimeoutMs: 1000,
    now: clock.now,
    log: quiet,
    ...o,
  });
  const define = (extra: Record<string, unknown> = {}) =>
    agents.create(parseAgent({ name: "weekly-review", description: "Sums up my week", instructions: "Look at the calendar and sum up my week.", ...extra }));
  return { db, conversations, clock, registry, calls, tool, agents, runs, stream, runtime, define };
}

/** The recorded entries of a conversation without ids and times. */
export const entries = (conversations: ReturnType<typeof setup>["store"], id: string) =>
  conversations.get(id)!.entries.map(({ seq: _s, at: _a, ...rest }) => rest);
