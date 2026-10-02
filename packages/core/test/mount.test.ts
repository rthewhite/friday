import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { ToolRegistry } from "@friday/sdk";
import { attachAudioWs } from "../src/transports/ws.js";
import { RemoteHost } from "../src/remote/host.js";
import { EnvKeyStore } from "../src/remote/key-store.js";
import { StubSession } from "./helpers.js";

const quiet = { log() {}, warn() {}, error() {} };

test("audio and remote endpoints coexist on one server; unknown paths get 404", async () => {
  const server = createServer();
  attachAudioWs(server, { pingMs: 0, createSession: (e) => new StubSession(e) });
  const remote = new RemoteHost({ registry: new ToolRegistry(quiet), keys: new EnvKeyStore("a=b"), pingMs: 0, helloTimeoutMs: 50, log: quiet });
  remote.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const audio = new WebSocket(`ws://127.0.0.1:${port}/ws/audio`);
    await once(audio, "open");
    const mods = new WebSocket(`ws://127.0.0.1:${port}/ws/modules`);
    await once(mods, "open");
    const [code] = await once(mods, "close"); // no hello
    assert.equal(code, 4408);
    const nope = new WebSocket(`ws://127.0.0.1:${port}/ws/nope`);
    const [err] = await once(nope, "error");
    assert.match((err as Error).message, /404/);
    audio.close();
    await once(audio, "close");
  } finally {
    await remote.closeAll();
    server.close();
    await once(server, "close");
  }
});
