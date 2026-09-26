/**
 * Test host: run a module against an in-memory registry with no server, no
 * Gemini and no environment leakage. `import { createTestHost } from "@friday/sdk/test"`.
 */
import { assertConfig, createContext, type Env } from "./context.js";
import type { FridayModule, ModuleLogger } from "./module.js";
import { ToolRegistry, type CallResult } from "./registry.js";

export interface TestHostOptions {
  /** Configuration the module sees. Defaults to an empty environment, not `process.env`. */
  env?: Env;
  /** Capture module log output; defaults to a silent logger. */
  log?: ModuleLogger;
}

export interface TestHost {
  tools: string[];
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  registry: ToolRegistry;
  dispose(): Promise<void>;
}

const silent: ModuleLogger = { log() {}, warn() {}, error() {} };

export async function createTestHost(module: FridayModule, opts: TestHostOptions = {}): Promise<TestHost> {
  const env = opts.env ?? {};
  const log = opts.log ?? silent;
  assertConfig(module.manifest, env);
  const registry = new ToolRegistry(log);
  await module.init(createContext(module.manifest, { env, registry, log }));
  return {
    tools: registry.names(module.manifest.id),
    call: (name, args) => registry.callTool(name, args),
    registry,
    dispose: async () => void (await module.dispose?.()),
  };
}
