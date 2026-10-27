import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
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

test("a malformed upgrade target is refused with 400 and doesn't take the server down; a throwing check answers 500", async () => {
  const server = createServer();
  attachAudioWs(server, { pingMs: 0, createSession: (e) => new StubSession(e), auth: { authenticate: async () => { throw new Error("boom"); } } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const raw = (target: string) =>
    new Promise<string>((resolve, reject) => {
      const sock = connect(port, "127.0.0.1", () => {
        sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
      });
      let out = "";
      sock.on("data", (d) => (out += d.toString()));
      sock.on("close", () => resolve(out));
      sock.on("error", reject);
    });
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    assert.match(await raw("//["), /^HTTP\/1\.1 400/);
    assert.match(await raw("/ws/audio"), /^HTTP\/1\.1 500/, "the check threw");
    assert.match(await raw("/ws/nope"), /^HTTP\/1\.1 404/, "still serving");
  } finally {
    console.error = origError;
    server.close();
  }
});
