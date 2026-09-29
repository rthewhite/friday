import { createServer } from "node:http";
import { ToolRegistry } from "@friday/sdk";
import { settings } from "./config.js";
import { modules } from "./modules.js";
import { ModuleHost } from "./module-host.js";
import { McpSource } from "./tools/mcp.js";
import { McpServerStore } from "./tools/mcp-store.js";
import { CompositeKeyStore, EnvKeyStore, SqliteKeyStore } from "./remote/key-store.js";
import { RemoteHost } from "./remote/host.js";
import { openDatabase } from "./storage/db.js";
import { SqliteModuleStorage } from "./storage/module-kv.js";
import { ConversationStore } from "./conversations/store.js";
import { registerRetention } from "./conversations/retention.js";
import { coreConfig } from "./core-config.js";
import { ConfigStore } from "./secrets/config-store.js";
import { parseMasterKey } from "./secrets/crypto.js";
import { createResolver } from "./secrets/resolver.js";
import { attachAudioWs } from "./transports/ws.js";
import { createApp } from "./app.js";
import { JobStore } from "./jobs/store.js";
import { Scheduler } from "./jobs/scheduler.js";
import { GeminiTextModel } from "./llm/gemini.js";
import { LlmService } from "./llm/service.js";
import { ChatEngine } from "./chat/engine.js";

const db = openDatabase(settings.dataDir);
const masterKey = parseMasterKey(settings.masterKey);
const configStore = new ConfigStore(db, masterKey);
const mcpStore = new McpServerStore(db, masterKey);
if (!configStore.secretsEnabled) console.warn("secrets disabled: FRIDAY_MASTER_KEY is not set; plain configuration still works, secrets come from the environment only");
for (const f of configStore.verifyAll()) console.error(`config: ${f.scope}/${f.key} could not be decrypted and counts as unset`);
const keys = new SqliteKeyStore(db);
// Core's own key: stored for core or globally in the portal, else the environment; read at each use.
const coreKey = coreConfig(configStore, process.env);
const geminiKey = () => coreKey("GEMINI_API_KEY");
const jobStore = new JobStore(db, settings.jobHistory);
const interrupted = jobStore.markInterrupted(Date.now());
if (interrupted) console.warn(`jobs: ${interrupted} run(s) interrupted by the last shutdown marked cancelled`);
const jobs = new Scheduler({ store: jobStore, timezone: settings.timezone, catchupDelayMs: settings.jobCatchupDelayMs });
const conversations = new ConversationStore(db, { quietMinutes: settings.conversationQuietMinutes });

const registry = new ToolRegistry();
const llm = new LlmService({
  model: new GeminiTextModel(geminiKey),
  models: { standard: settings.textModel, fast: settings.textModelFast },
  concurrency: settings.llmConcurrency,
  timeoutMs: settings.llmTimeoutMs,
  maxRetryWaitMs: settings.llmMaxRetryWaitMs,
});
const host = new ModuleHost(registry, {
  enabled: process.env.FRIDAY_MODULES,
  resolve: createResolver(configStore, process.env),
  storage: (id) => new SqliteModuleStorage(db, id),
  jobs: (id) => jobs.forOwner(id),
  llm: (id) => llm.forOwner(id),
  conversations: (id) => conversations.forOwner(id),
});
const mcp = new McpSource(registry, mcpStore);
const remote = new RemoteHost({
  registry,
  keys: new CompositeKeyStore([keys, new EnvKeyStore(settings.moduleKeys)]),
  pingMs: settings.wsPingMs,
  callTimeoutMs: settings.remoteCallTimeoutMs,
});

await host.load(modules);
await mcp.load();
if (!geminiKey()) console.warn("GEMINI_API_KEY is not set (Settings > Configuration > Secrets, or the environment)");
console.log(`tools (${registry.names().length}):`, registry.names().join(", "));
conversations.start();
registerRetention(jobs, conversations, settings.conversationRetentionDays);

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    conversations.stop();
    void remote.closeAll().then(() => jobs.stop()).then(() => host.dispose()).then(() => mcp.close()).finally(() => { db.close(); process.exit(0); });
  });
}

const chat = new ChatEngine({
  store: conversations,
  registry,
  llm,
  model: settings.chatModel,
  system: settings.chatPrompt,
  toolTimeoutMs: settings.chatToolTimeoutMs,
});

const server = createServer(createApp({ registry, host, mcp, mcpStore, remote, webDir: settings.webDir, configStore, keys, env: process.env, jobs, conversations, chat }));
attachAudioWs(server, { registry, conversations, geminiKey });
remote.attach(server);

server.listen(settings.port, settings.host, () =>
  console.log(`friday listening on http://${settings.host}:${settings.port}`),
);
