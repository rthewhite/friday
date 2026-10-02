import { createServer, type Server } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { attachAudioWs, type AudioSession, type AudioWsOptions } from "../src/transports/ws.js";
import type { Event } from "../src/session.js";
import type { ConversationRecorder } from "../src/conversations/recorder.js";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DeviceStore, fingerprint, type DeviceSnapshot } from "../src/devices/store.js";
import { DeviceSessions } from "../src/devices/sessions.js";
import { hashKey } from "../src/remote/key-store.js";
import { migrate, migrations } from "../src/storage/db.js";

export class StubSession implements AudioSession {
  static instances: StubSession[] = [];
  audio: Buffer[] = [];
  texts: string[] = [];
  closed = 0;
  failOpen = false;
  constructor(public emit: (e: Event) => void, public recorder?: ConversationRecorder, public device?: DeviceSnapshot) {
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
  /** Open a socket; `key` is sent as `Authorization: Bearer <key>`. */
  connect(query?: string, key?: string): Promise<WebSocket>;
  /** Connect and wait for the server to close the socket; resolves with the close code and reason. */
  rejected(query: string, key?: string): Promise<{ code: number; reason: string }>;
  close(): Promise<void>;
}

const authHeaders = (key?: string) => (key === undefined ? undefined : { headers: { authorization: `Bearer ${key}` } });

/** Start the transport on a random port with StubSession injected and console captured. */
export async function startHarness(opts: Omit<AudioWsOptions, "createSession"> = {}): Promise<Harness> {
  StubSession.instances = [];
  const logs: string[] = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  console.error = (...a) => logs.push(a.map(String).join(" "));

  const server = createServer();
  const wss = attachAudioWs(server, { pingMs: 0, ...opts, createSession: (e, r, d) => new StubSession(e, r, d) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const url = `ws://127.0.0.1:${port}/ws/audio`;

  return {
    server,
    url,
    logs,
    async connect(query = "", key?: string) {
      const ws = new WebSocket(url + query, authHeaders(key));
      await once(ws, "open");
      return ws;
    },
    async rejected(query: string, key?: string) {
      const ws = new WebSocket(url + query, authHeaders(key));
      const [code, reason] = (await once(ws, "close")) as [number, Buffer];
      return { code, reason: reason.toString() };
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

/** An in-memory device store with `register(id)` onboarding a device as a device and the user would; returns its key. */
export function deviceFixture() {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, { log() {} });
  const store = new DeviceStore(db);
  const sessions = new DeviceSessions();
  const register = (id: string, body: { label?: string; area?: string; notes?: string } = {}) => {
    const key = randomBytes(32).toString("base64url");
    store.authenticate(id, key);
    store.accept(id, { fingerprint: fingerprint(hashKey(key)), ...body });
    return key;
  };
  return { db, store, sessions, register };
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
