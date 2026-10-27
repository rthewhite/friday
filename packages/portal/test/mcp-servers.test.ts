import { test } from "node:test";
import assert from "node:assert/strict";
import { blankDraft, canSave, CHANNELS, channelsOf, draftOf, needsValue, rowsOf, saveBody, serverFromQuery, type Channel, type Server } from "../src/lib/mcp-servers.ts";

const server = (over: Partial<Server> = {}): Server => ({
  name: "home",
  enabled: true,
  url: "https://ha.example/mcp",
  headers: [{ name: "Authorization", secret: true }, { name: "X-Plain", secret: false, value: "v" }],
  status: "loaded",
  tools: [],
  updatedAt: "2026-10-27T10:00:00Z",
  ...over,
});

test("a stored server fills the form: secret values start empty, unset channels are all three", () => {
  const d = draftOf(server({ include: ["turn_on", "turn_off"], scheduling: "SILENT" }));
  assert.deepEqual(d.headers, [
    { name: "Authorization", value: "", secret: true, stored: true },
    { name: "X-Plain", value: "v", secret: false, stored: false },
  ]);
  assert.equal(d.include, "turn_on\nturn_off");
  assert.equal(d.scheduling, "SILENT");
  assert.deepEqual(d.channels, CHANNELS);
  assert.deepEqual(channelsOf(server({ channels: ["agent"] })), ["agent"]);
  assert.deepEqual(rowsOf([]), []);
});

test("a stored secret left empty is kept: sent without a value; a typed one is replaced", () => {
  const d = draftOf(server());
  assert.deepEqual(saveBody(d, false).headers, [{ name: "Authorization", secret: true }, { name: "X-Plain", value: "v", secret: false }]);
  d.headers[0]!.value = "Bearer new";
  assert.deepEqual(saveBody(d, false).headers[0], { name: "Authorization", value: "Bearer new", secret: true });
});

test("the body trims, drops nameless rows, sends a name only when adding, and keeps channels in order", () => {
  const d = { ...blankDraft(), name: " home ", url: "https://ha.example/mcp", include: " a \n\nb ", prefix: " ", channels: ["agent", "voice"] as Channel[] };
  d.headers.push({ name: " ", value: "x", secret: false, stored: false }, { name: " X-A ", value: "1", secret: false, stored: false });
  assert.deepEqual(saveBody(d, true), {
    name: "home", enabled: true, url: "https://ha.example/mcp", headers: [{ name: "X-A", value: "1", secret: false }],
    include: ["a", "b"], exclude: [], scheduling: undefined, prefix: undefined, channels: ["voice", "agent"],
  });
  assert.equal("name" in saveBody(d, false), false);
});

test("a stored secret switched to plain needs a value before saving", () => {
  const d = draftOf(server());
  assert.equal(canSave(d, false), true);
  d.headers[0]!.secret = false;
  assert.equal(needsValue(d.headers[0]!), true);
  assert.equal(canSave(d, false), false);
  d.headers[0]!.value = "plain now";
  assert.equal(canSave(d, false), true);
});

test("saving needs a name when adding, a URL and a channel", () => {
  const d = { ...blankDraft(), url: "https://x.example" };
  assert.equal(canSave(d, true), false, "no name");
  assert.equal(canSave({ ...d, name: "x" }, true), true);
  assert.equal(canSave({ ...d, name: "x", url: " " }, true), false);
  assert.equal(canSave({ ...d, name: "x", channels: [] }, true), false);
  assert.equal(canSave(d, false), true, "editing keeps the stored name");
});

test("?server= opens a server only on the MCP tab", () => {
  const list = [server(), server({ name: "github" })];
  assert.equal(serverFromQuery({ tab: "mcp", server: "github" }, list)?.name, "github");
  assert.equal(serverFromQuery({ tab: "secrets", server: "github" }, list), undefined);
  assert.equal(serverFromQuery({ tab: "mcp", server: "nope" }, list), undefined);
});
