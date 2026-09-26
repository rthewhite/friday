import { createServer } from "node:http";
import { ToolRegistry } from "@friday/sdk";
import { settings } from "./config.js";
import { modules } from "./modules.js";
import { ModuleHost } from "./module-host.js";
import { McpSource } from "./tools/mcp.js";
import { attachAudioWs } from "./transports/ws.js";
import { createApp } from "./app.js";

const registry = new ToolRegistry();
const host = new ModuleHost(registry, { enabled: process.env.FRIDAY_MODULES });
const mcp = new McpSource(registry);

await host.load(modules);
await mcp.load();
if (!settings.apiKey) console.warn("GEMINI_API_KEY is not set");
console.log(`tools (${registry.names().length}):`, registry.names().join(", "));

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void host.dispose().then(() => mcp.close()).finally(() => process.exit(0));
  });
}

const server = createServer(createApp({ registry, host, mcp, webDir: settings.webDir }));
attachAudioWs(server, { registry });

server.listen(settings.port, settings.host, () =>
  console.log(`friday listening on http://${settings.host}:${settings.port}`),
);
