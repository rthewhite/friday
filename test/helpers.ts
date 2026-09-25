import { createServer, type Server } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { attachAudioWs, type AudioSession, type AudioWsOptions } from "../src/transports/ws.js";
import type { Event } from "../src/session.js";

export class StubSession implements AudioSession {
  static instances: StubSession[] = [];
  audio: Buffer[] = [];
  texts: string[] = [];
  closed = 0;
  failOpen = false;
  constructor(public emit: (e: Event) => void) {
    StubSession.instances.push(this);
  }
  async open() {
    if (this.failOpen) throw new Error("nope");
  }
  sendAudio(b: Buffer) {
    this.audio.push(Buffer.from(b));
  }
  sendText(t: string) {
    this.texts.push(t);
  }
  close() {
    this.closed++;
  }
}

export interface Harness {
  server: Server;
  url: string;
  logs: string[];
  connect(query?: string): Promise<WebSocket>;
  close(): Promise<void>;
}

/** Start the transport on a random port with StubSession injected and console captured. */
export async function startHarness(opts: Omit<AudioWsOptions, "createSession"> = {}): Promise<Harness> {
  StubSession.instances = [];
  const logs: string[] = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  console.error = (...a) => logs.push(a.map(String).join(" "));

  const server = createServer();
  const wss = attachAudioWs(server, { pingMs: 0, ...opts, createSession: (e) => new StubSession(e) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const url = `ws://127.0.0.1:${port}/ws/audio`;

  return {
    server,
    url,
    logs,
    async connect(query = "") {
      const ws = new WebSocket(url + query);
      await once(ws, "open");
      return ws;
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close();
      await once(server, "close");
      console.log = origLog;
      console.error = origErr;
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred` is true or `ms` elapses. */
export async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("waitFor timeout");
    await sleep(10);
  }
}
