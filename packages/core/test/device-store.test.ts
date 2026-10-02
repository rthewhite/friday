import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations } from "../src/storage/db.js";
import { hashKey } from "../src/remote/key-store.js";
import { DeviceConflict, DeviceInputError, DeviceNotFound, DeviceStore, fingerprint } from "../src/devices/store.js";

const quiet = { log() {} };
const newKey = () => randomBytes(32).toString("base64url");
const fp = (key: string) => fingerprint(hashKey(key));

function setup(start = Date.parse("2026-10-02T10:00:00Z")) {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const clock = { t: start };
  const store = new DeviceStore(db, { now: () => new Date(clock.t) });
  /** Register `id` with `key` through the pending flow, as a device and the user would. */
  const onboard = (id: string, key = newKey(), body: { label?: string; area?: string; notes?: string } = {}) => {
    store.authenticate(id, key);
    store.accept(id, { fingerprint: fp(key), ...body });
    return key;
  };
  return { db, clock, store, onboard };
}

test("an accepted device's key is stored as a hash only", () => {
  const { db, onboard } = setup();
  const key = onboard("friday-kitchen");
  const dump = JSON.stringify([...db.prepare("SELECT * FROM devices").all(), ...db.prepare("SELECT * FROM device_attempts").all()]);
  assert.ok(!dump.includes(key), "plaintext key is not stored");
  assert.ok(dump.includes(hashKey(key)));
});

test("the fingerprint is the first 8 hex characters of the hash, grouped by four", () => {
  assert.equal(fingerprint("3f9ac21e" + "0".repeat(56)), "3f9a-c21e");
});

test("a new device is recorded as pending and repeated attempts update one row", () => {
  const { store, clock } = setup();
  const key = newKey();
  assert.deepEqual(store.authenticate("friday-kitchen", key), { ok: false, code: 4403, reason: "pending approval" });
  let { pending } = store.list();
  assert.deepEqual(pending, [{ id: "friday-kitchen", fingerprint: fp(key), firstSeenAt: "2026-10-02T10:00:00.000Z", lastSeenAt: "2026-10-02T10:00:00.000Z", attempts: 1 }]);
  clock.t += 60_000;
  store.authenticate("friday-kitchen", key);
  clock.t += 60_000;
  store.authenticate("friday-kitchen", key);
  ({ pending } = store.list());
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempts, 3);
  assert.equal(pending[0].firstSeenAt, "2026-10-02T10:00:00.000Z");
  assert.equal(pending[0].lastSeenAt, "2026-10-02T10:02:00.000Z");
  const other = newKey();
  store.authenticate("friday-kitchen", other);
  assert.equal(store.list().pending[0].fingerprint, fp(other), "a later attempt with another key replaces the key");
});

test("a pending attempt disappears 24 hours after its last attempt", () => {
  const { store, clock } = setup();
  store.authenticate("friday-kitchen", newKey());
  clock.t += 24 * 60 * 60 * 1000 - 1;
  assert.equal(store.list().pending.length, 1);
  clock.t += 2;
  assert.equal(store.list().pending.length, 0);
});

test("at most 20 pending attempts are kept, dropping those last seen longest ago", () => {
  const { store, clock } = setup();
  for (let i = 0; i < 25; i++) {
    store.authenticate(`sat-${i}`, newKey());
    clock.t += 1000;
  }
  const ids = store.list().pending.map((p) => p.id);
  assert.equal(ids.length, 20);
  assert.ok(!ids.includes("sat-4") && ids.includes("sat-5") && ids.includes("sat-24"));
});

test("connections without a key, or with a malformed id or key, record nothing", () => {
  const { store } = setup();
  assert.deepEqual(store.authenticate("friday-kitchen", undefined), { ok: false, code: 4401, reason: "unauthorized" });
  assert.deepEqual(store.authenticate("Kitchen!", newKey()), { ok: false, code: 4400, reason: "bad device" });
  assert.deepEqual(store.authenticate("friday-kitchen", "short"), { ok: false, code: 4400, reason: "bad device" });
  assert.deepEqual(store.authenticate("-kitchen", newKey()), { ok: false, code: 4400, reason: "bad device" });
  assert.deepEqual(store.list().pending, []);
});

test("accepting registers the key the user saw, and the device's next connection is accepted", () => {
  const { store, clock } = setup();
  const key = newKey();
  store.authenticate("friday-kitchen", key);
  const d = store.accept("friday-kitchen", { fingerprint: fp(key), label: " Kitchen satellite ", area: "Kitchen", notes: "" });
  assert.deepEqual({ id: d.id, label: d.label, area: d.area, notes: d.notes, revoked: d.revoked }, { id: "friday-kitchen", label: "Kitchen satellite", area: "Kitchen", notes: null, revoked: false });
  assert.deepEqual(store.list().pending, []);
  clock.t += 5000;
  assert.deepEqual(store.authenticate("friday-kitchen", key), { ok: true, device: { id: "friday-kitchen", label: "Kitchen satellite", area: "Kitchen", notes: null } });
  assert.equal(store.get("friday-kitchen")!.lastSeenAt, "2026-10-02T10:00:05.000Z");
});

test("accepting without a label uses the id", () => {
  const { store, onboard } = setup();
  onboard("friday-kitchen");
  assert.equal(store.get("friday-kitchen")!.label, "friday-kitchen");
});

test("accepting is refused when the attempt's key changed after the user looked", () => {
  const { store } = setup();
  const seen = newKey();
  store.authenticate("friday-kitchen", seen);
  const newer = newKey();
  store.authenticate("friday-kitchen", newer);
  assert.throws(() => store.accept("friday-kitchen", { fingerprint: fp(seen) }), DeviceConflict);
  assert.equal(store.list().devices.length, 0);
  assert.equal(store.list().pending[0].fingerprint, fp(newer), "the attempt keeps the newer key");
  assert.throws(() => store.accept("nope", { fingerprint: fp(seen) }), DeviceNotFound);
  assert.throws(() => store.accept("friday-kitchen", {}), DeviceInputError);
});

test("ignoring removes the attempt until the device connects again", () => {
  const { store } = setup();
  const key = newKey();
  store.authenticate("friday-kitchen", key);
  store.ignore("friday-kitchen");
  assert.deepEqual(store.list().pending, []);
  store.authenticate("friday-kitchen", key);
  assert.equal(store.list().pending.length, 1);
  assert.throws(() => store.ignore("nope"), DeviceNotFound);
});

test("a known device with a different key is a pending replacement and its old key keeps working", () => {
  const { store, onboard } = setup();
  const old = onboard("friday-voice", newKey(), { label: "Living room", area: "Living room", notes: "By the TV" });
  const fresh = newKey();
  assert.deepEqual(store.authenticate("friday-voice", fresh), { ok: false, code: 4403, reason: "pending approval" });
  const { devices, pending } = store.list();
  assert.deepEqual(pending, [], "a replacement is not listed as an unknown device");
  assert.equal(devices[0].replacement?.fingerprint, fp(fresh));
  assert.equal(devices[0].replacement?.attempts, 1);
  assert.equal(store.authenticate("friday-voice", old).ok, true);
});

test("replacing the key keeps the metadata and only the new key is accepted", () => {
  const { store, onboard } = setup();
  const old = onboard("friday-voice", newKey(), { label: "Living room", area: "Living room", notes: "By the TV" });
  const fresh = newKey();
  store.authenticate("friday-voice", fresh);
  assert.throws(() => store.replaceKey("friday-voice", { fingerprint: fp(old) }), DeviceConflict, "a stale fingerprint is refused");
  const d = store.replaceKey("friday-voice", { fingerprint: fp(fresh) });
  assert.deepEqual({ label: d.label, area: d.area, notes: d.notes, fingerprint: d.fingerprint }, { label: "Living room", area: "Living room", notes: "By the TV", fingerprint: fp(fresh) });
  assert.ok(d.keyReplacedAt);
  assert.equal(d.replacement, undefined);
  assert.throws(() => store.replaceKey("friday-voice", { fingerprint: fp(fresh) }), DeviceNotFound, "nothing pending any more");
  assert.equal(store.authenticate("friday-voice", fresh).ok, true);
  assert.equal(store.authenticate("friday-voice", old).ok, false);
  assert.equal(store.get("friday-voice")!.replacement?.fingerprint, fp(old), "the old key now shows up as a replacement");
});

test("editing applies the limits and leaves omitted fields alone", () => {
  const { store, onboard } = setup();
  onboard("friday-kitchen", newKey(), { label: "Kitchen", area: "Kitchen", notes: "Next to the fridge" });
  const d = store.update("friday-kitchen", { area: "Living room" });
  assert.deepEqual({ label: d.label, area: d.area, notes: d.notes }, { label: "Kitchen", area: "Living room", notes: "Next to the fridge" });
  assert.equal(store.update("friday-kitchen", { notes: "" }).notes, null, "empty clears");
  assert.throws(() => store.update("friday-kitchen", { notes: "x".repeat(1001) }), /notes must be at most 1000 characters/);
  assert.throws(() => store.update("friday-kitchen", { label: "" }), /label must not be empty/);
  assert.throws(() => store.update("friday-kitchen", { area: "x".repeat(81) }), /area must be at most 80/);
  assert.throws(() => store.update("friday-kitchen", { label: 3 }), DeviceInputError);
  assert.equal(store.update("friday-kitchen", { notes: "x".repeat(1000) }).notes?.length, 1000);
  assert.throws(() => store.update("nope", {}), DeviceNotFound);
});

test("a revoked device is rejected whatever key it presents, and is not recorded as pending", () => {
  const { store, onboard } = setup();
  const key = onboard("friday-kitchen");
  store.authenticate("friday-kitchen", newKey()); // a replacement was pending
  const d = store.revoke("friday-kitchen");
  assert.equal(d.revoked, true);
  assert.equal(d.replacement, undefined, "revoking drops a pending replacement");
  assert.deepEqual(store.authenticate("friday-kitchen", key), { ok: false, code: 4401, reason: "unauthorized" });
  assert.deepEqual(store.authenticate("friday-kitchen", newKey()), { ok: false, code: 4401, reason: "unauthorized" });
  assert.deepEqual(store.list().pending, []);
  assert.equal(store.list().devices[0].replacement, undefined);
});

test("a deleted device is recorded as pending when it connects again", () => {
  const { store, onboard } = setup();
  const key = onboard("friday-kitchen");
  store.revoke("friday-kitchen");
  store.remove("friday-kitchen");
  assert.deepEqual(store.list().devices, []);
  assert.equal(store.authenticate("friday-kitchen", key).ok, false);
  assert.deepEqual(store.list().pending.map((p) => p.id), ["friday-kitchen"]);
  assert.throws(() => store.remove("friday-kitchen"), DeviceNotFound);
});

test("listings never carry a key or a key hash", () => {
  const { store, onboard } = setup();
  const key = onboard("friday-kitchen");
  store.authenticate("friday-kitchen", newKey());
  const other = newKey();
  store.authenticate("friday-hall", other);
  const json = JSON.stringify(store.list());
  for (const secret of [key, other, hashKey(key), hashKey(other)]) assert.ok(!json.includes(secret));
});

test("device sessions: connected while any socket is open, and disconnect closes them all", async () => {
  const { DeviceSessions } = await import("../src/devices/sessions.js");
  const sessions = new DeviceSessions();
  const closed: string[] = [];
  const sock = (name: string) => ({ close: (code?: number, reason?: string) => void closed.push(`${name} ${code} ${reason}`) });
  const a = sock("a"), b = sock("b");
  sessions.add("friday-kitchen", a);
  sessions.add("friday-kitchen", b);
  assert.equal(sessions.connected("friday-kitchen"), true);
  sessions.remove("friday-kitchen", a);
  assert.equal(sessions.connected("friday-kitchen"), true, "one of two still open");
  sessions.add("friday-kitchen", a);
  sessions.disconnect("friday-kitchen");
  assert.deepEqual(closed.sort(), ["a 4401 unauthorized", "b 4401 unauthorized"]);
  assert.equal(sessions.connected("friday-kitchen"), false);
  sessions.remove("friday-kitchen", a); // the close handler running afterwards is harmless
  assert.equal(sessions.connected("friday-hall"), false);
});
