import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceLinks } from "../src/devices/links.js";
import { DeviceSessions } from "../src/devices/sessions.js";

class FakeSocket {
  sent: string[] = [];
  closes: [number | undefined, string | undefined][] = [];
  send(d: string) {
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    this.closes.push([code, reason]);
  }
}

test("a control connection makes the device online and tells the online listeners", () => {
  const links = new DeviceLinks();
  const seen: string[] = [];
  links.onOnline((id) => seen.push(id));
  assert.equal(links.online("friday-kitchen"), false);
  links.add("friday-kitchen", new FakeSocket());
  assert.equal(links.online("friday-kitchen"), true);
  assert.deepEqual(seen, ["friday-kitchen"]);
});

test("a second control connection replaces the first with 4409, and the old one closing later changes nothing", () => {
  const links = new DeviceLinks();
  const first = new FakeSocket(), second = new FakeSocket();
  links.add("friday-kitchen", first);
  links.add("friday-kitchen", second);
  assert.deepEqual(first.closes, [[4409, "replaced"]]);
  links.remove("friday-kitchen", first);
  assert.equal(links.online("friday-kitchen"), true);
  links.send("friday-kitchen", { type: "ring", data: { alert: "k3f9" } });
  assert.equal(second.sent.length, 1);
  assert.equal(first.sent.length, 0);
  links.remove("friday-kitchen", second);
  assert.equal(links.online("friday-kitchen"), false);
});

test("send() writes the JSON message, and is false without a control connection", () => {
  const links = new DeviceLinks();
  const ws = new FakeSocket();
  assert.equal(links.send("friday-kitchen", { type: "ring", data: { alert: "k3f9" } }), false);
  links.add("friday-kitchen", ws);
  assert.equal(links.send("friday-kitchen", { type: "stop", data: { alert: "k3f9" } }), true);
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s)), [{ type: "stop", data: { alert: "k3f9" } }]);
});

test("disconnect() closes the control connection with 4401 and the device is offline", () => {
  const links = new DeviceLinks();
  const ws = new FakeSocket();
  links.add("friday-kitchen", ws);
  links.disconnect("friday-kitchen");
  assert.deepEqual(ws.closes, [[4401, "unauthorized"]]);
  assert.equal(links.online("friday-kitchen"), false);
  links.disconnect("friday-kitchen");
});

test("an unsubscribed online listener is no longer called", () => {
  const links = new DeviceLinks();
  const seen: string[] = [];
  const off = links.onOnline((id) => seen.push(id));
  off();
  links.add("friday-kitchen", new FakeSocket());
  assert.deepEqual(seen, []);
});

test("DeviceSessions tells idle listeners when a device's last audio connection closes", () => {
  const sessions = new DeviceSessions();
  const idle: string[] = [];
  sessions.onIdle((id) => idle.push(id));
  const a = new FakeSocket(), b = new FakeSocket();
  sessions.add("friday-kitchen", a);
  sessions.add("friday-kitchen", b);
  sessions.remove("friday-kitchen", a);
  assert.deepEqual(idle, [], "still in a session while one connection is open");
  sessions.remove("friday-kitchen", b);
  assert.deepEqual(idle, ["friday-kitchen"]);
  sessions.remove("friday-kitchen", b);
  assert.deepEqual(idle, ["friday-kitchen"], "removing an unknown socket says nothing");
});
