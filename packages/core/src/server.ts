import { createServer } from "node:http";
import { ToolRegistry } from "@friday/sdk";
import { settings } from "./config.js";
import { modules } from "./modules.js";
import { ModuleHost } from "./module-host.js";
import { McpSource } from "./tools/mcp.js";
import { CompositeKeyStore, EnvKeyStore, SqliteKeyStore } from "./remote/key-store.js";
import { RemoteHost } from "./remote/host.js";
import { openDatabase } from "./storage/db.js";
import { SqliteModuleStorage } from "./storage/module-kv.js";
import { ConversationStore } from "./conversations/store.js";
import { ConfigStore } from "./secrets/config-store.js";
import { parseMasterKey } from "./secrets/crypto.js";
import { createResolver } from "./secrets/resolver.js";
import { attachAudioWs } from "./transports/ws.js";
import { createApp } from "./app.js";

const db = openDatabase(settings.dataDir);
const configStore = new ConfigStore(db, parseMasterKey(settings.masterKey));
if (!configStore.secretsEnabled) console.warn("secrets disabled: FRIDAY_MASTER_KEY is not set; plain configuration still works, secrets come from the environment only");
for (const f of configStore.verifyAll()) console.error(`config: ${f.scope}/${f.key} could not be decrypted and counts as unset`);
const keys = new SqliteKeyStore(db);
const conversations = new ConversationStore(db, { quietMinutes: settings.conversationQuietMinutes });

const registry = new ToolRegistry();
const host = new ModuleHost(registry, {
  enabled: process.env.FRIDAY_MODULES,
  resolve: createResolver(configStore, process.env),
  storage: (id) => new SqliteModuleStorage(db, id),
  conversations: (id) => conversations.forOwner(id),
});
const mcp = new McpSource(registry);
const remote = new RemoteHost({
  registry,
  keys: new CompositeKeyStore([keys, new EnvKeyStore(settings.moduleKeys)]),
  pingMs: settings.wsPingMs,
  callTimeoutMs: settings.remoteCallTimeoutMs,
});

await host.load(modules);
await mcp.load();
if (!settings.apiKey) console.warn("GEMINI_API_KEY is not set");
console.log(`tools (${registry.names().length}):`, registry.names().join(", "));
conversations.start();

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    conversations.stop();
    void remote.closeAll().then(() => host.dispose()).then(() => mcp.close()).finally(() => { db.close(); process.exit(0); });
  });
}

const server = createServer(createApp({ registry, host, mcp, remote, webDir: settings.webDir, configStore, keys, env: process.env, conversations }));
attachAudioWs(server, { registry, conversations });
remote.attach(server);

server.listen(settings.port, settings.host, () =>
  console.log(`friday listening on http://${settings.host}:${settings.port}`),
);
