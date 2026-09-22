import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { WebSocketServer } from "ws";
import { settings } from "./config.js";
import { declarations, loadTools, toolNames } from "./tools/index.js";
import { closeMcp } from "./tools/mcp.js";
import { serveWs } from "./transports/ws.js";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

await loadTools();
if (!settings.apiKey) console.warn("GEMINI_API_KEY is not set");
console.log("tools:", toolNames());
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void closeMcp().finally(() => process.exit(0)));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/api/tools") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(declarations()));
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  try {
    const body = await readFile(join(WEB, file));
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});

const wss = new WebSocketServer({ server, path: "/ws/audio" });
wss.on("connection", (ws) => void serveWs(ws));

server.listen(settings.port, settings.host, () =>
  console.log(`friday listening on http://localhost:${settings.port}`),
);
