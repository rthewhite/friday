import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations, openDatabase } from "../src/storage/db.js";
import { McpInputError, McpServerExists, McpServerStore, McpStoreDisabled, parseServerInput } from "../src/tools/mcp-store.js";

const quiet = { log() {} };
const key = randomBytes(32);
const memDb = () => { const d = new DatabaseSync(":memory:"); d.exec("PRAGMA foreign_keys = ON"); migrate(d, migrations, quiet); return d; };
const TOKEN = "Bearer sup3r-s3cret";

const http = (extra: Record<string, unknown> = {}) => ({ name: "home", transport: "http", url: "https://ha.example/api/mcp", ...extra });
const withToken = (extra: Record<string, unknown> = {}) => parseServerInput(http({ headers: [{ name: "Authorization", value: TOKEN, secret: true }], ...extra }));

test("parseServerInput rejects each invalid field with a 400-class error", () => {
  const bad: [string, unknown, RegExp][] = [
    ["not an object", [], /JSON object/],
    ["name with a space", http({ name: "home assistant" }), /name must start with a letter/],
    ["name starting with a digit", http({ name: "1home" }), /name must/],
    ["name too long", http({ name: "a".repeat(33) }), /max 32/],
    ["no url", http({ url: undefined }), /a url is required/],
    ["stdio server", { name: "fs", transport: "stdio", command: "npx", args: ["-y", "server"] }, /only MCP servers reachable over HTTP/],
    ["command without transport", http({ command: "/bin/sh" }), /Friday does not start MCP server processes/],
    ["other transport", http({ transport: "ws" }), /only MCP servers reachable over HTTP/],
    ["url not http(s)", http({ url: "file:///etc/passwd" }), /http or https/],
    ["url unparsable", http({ url: "nope" }), /not a valid URL/],
    ["include not a list", http({ include: "turn_on" }), /include must be a list/],
    ["bad scheduling", http({ scheduling: "LATER" }), /scheduling must be one of/],
    ["enabled not boolean", http({ enabled: "yes" }), /enabled must be a boolean/],
    ["header name invalid", http({ headers: [{ name: "Bad Header", value: "v" }] }), /invalid header name/],
    ["duplicate header, any case", http({ headers: [{ name: "X-A", value: "1" }, { name: "x-a", value: "2" }] }), /duplicate header/],
    ["entry value not a string", http({ headers: [{ name: "X-A", value: 1 }] }), /must be a string/],
    ["header value with a newline", http({ headers: [{ name: "Authorization", value: "Bearer abc\n", secret: true }] }), /header "Authorization" contains a line break/],
    ["header value with CR", http({ headers: [{ name: "X-A", value: "a\rb" }] }), /line break or control character/],
  ];
  for (const [label, body, re] of bad) {
    assert.throws(() => parseServerInput(body), (e: unknown) => e instanceof McpInputError && re.test(e.message), label);
  }
});

test("parseServerInput takes the name from the body on create and forbids changing it on update", () => {
  assert.equal(parseServerInput(http()).name, "home");
  assert.equal(parseServerInput({ transport: "http", url: "http://x" }, "home").name, "home");
  assert.equal(parseServerInput(http(), "home").name, "home");
  assert.throws(() => parseServerInput(http({ name: "other" }), "home"), /cannot be changed/);
});

test("parseServerInput treats empty lists and strings as unset and keeps a blank secret as 'keep'", () => {
  assert.deepEqual(parseServerInput(http({ include: [], exclude: [], scheduling: "", prefix: "", transport: "http" })), { name: "home", enabled: true, url: "https://ha.example/api/mcp", headers: [] });
  assert.deepEqual(parseServerInput(http({ enabled: false, url: " http://x/mcp ", scheduling: "SILENT", prefix: "ha", include: ["a"] })), { name: "home", enabled: false, url: "http://x/mcp", headers: [], include: ["a"], scheduling: "SILENT", prefix: "ha" });
  assert.deepEqual(parseServerInput(http({ headers: [{ name: "Authorization", value: "", secret: true }] })).headers, [{ name: "Authorization", secret: true }]);
});

test("create stores secrets as ciphertext, lists them without values, and resolves the plaintext", () => {
  const db = memDb();
  const store = new McpServerStore(db, key);
  const created = store.create(withToken({ headers: [{ name: "Authorization", value: TOKEN, secret: true }, { name: "X-Client", value: "friday", secret: false }], include: ["turn_on"] }));
  assert.deepEqual(created.headers, [{ name: "Authorization", secret: true }, { name: "X-Client", secret: false, value: "friday" }]);
  assert.deepEqual(created.include, ["turn_on"]);
  const row = db.prepare("SELECT plaintext, ciphertext FROM mcp_server_headers WHERE name = 'Authorization'").get() as { plaintext: string | null; ciphertext: Uint8Array };
  assert.equal(row.plaintext, null);
  assert.ok(!Buffer.from(row.ciphertext).toString("utf8").includes("s3cret"));
  assert.ok(!JSON.stringify(store.list()).includes("s3cret"));
  assert.deepEqual(store.resolve("home")!.headers, { Authorization: TOKEN, "X-Client": "friday" });
  assert.equal(store.resolve("nope"), undefined);
  assert.throws(() => store.create(withToken()), McpServerExists);
});

test("a definition survives reopening the database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friday-mcp-store-"));
  const a = openDatabase(dir, "friday.db", quiet);
  new McpServerStore(a, key).create(parseServerInput(http({ headers: [{ name: "Authorization", value: "t0k", secret: true }], scheduling: "SILENT", exclude: ["x"] })));
  a.close();
  const store = new McpServerStore(openDatabase(dir, "friday.db", quiet), key);
  const r = store.resolve("home")!;
  assert.deepEqual([r.url, r.headers, r.scheduling, r.exclude, r.enabled], ["https://ha.example/api/mcp", { Authorization: "t0k" }, "SILENT", ["x"], true]);
});

test("update merge rules: keep, re-encrypt, reject and delete entries", () => {
  const store = new McpServerStore(memDb(), key);
  store.create(withToken({ headers: [{ name: "Authorization", value: TOKEN, secret: true }, { name: "X-Plain", value: "p", secret: false }, { name: "X-Gone", value: "g", secret: false }] }));

  // plain + value → stored plain (was plain); secret without value, stored secret → kept;
  // secret without value, stored plain → stored plaintext encrypted; omitted → deleted.
  store.update(parseServerInput(http({ scheduling: "SILENT", headers: [{ name: "Authorization", secret: true }, { name: "X-Plain", secret: true }, { name: "X-New", value: "n" }] })));
  const s = store.get("home")!;
  assert.equal(s.scheduling, "SILENT");
  assert.deepEqual(s.headers, [{ name: "Authorization", secret: true }, { name: "X-Plain", secret: true }, { name: "X-New", secret: false, value: "n" }]);
  assert.deepEqual(store.resolve("home")!.headers, { Authorization: TOKEN, "X-Plain": "p", "X-New": "n" });

  // secret + value → new ciphertext; plain + value over a secret → stored plain.
  store.update(parseServerInput(http({ headers: [{ name: "Authorization", value: "Bearer new", secret: true }, { name: "X-Plain", value: "visible" }] })));
  assert.deepEqual(store.resolve("home")!.headers, { Authorization: "Bearer new", "X-Plain": "visible" });

  // secret without value and nothing stored → 400; plain without value → 400. Nothing changes.
  const before = store.resolve("home");
  assert.throws(() => store.update(parseServerInput(http({ headers: [{ name: "X-Other", secret: true }] }))), (e: unknown) => e instanceof McpInputError && /no stored value/.test(e.message));
  assert.throws(() => store.update(parseServerInput(http({ headers: [{ name: "X-Plain" }] }))), (e: unknown) => e instanceof McpInputError && /needs a value/.test(e.message));
  assert.deepEqual(store.resolve("home"), before);

  assert.equal(store.update(parseServerInput(http({ name: "ghost" }))), undefined);
});

test("without a master key new secrets are refused, plain values and kept ciphertext still work", () => {
  const db = memDb();
  new McpServerStore(db, key).create(withToken());
  const store = new McpServerStore(db, undefined);
  assert.equal(store.secretsEnabled, false);
  assert.throws(() => store.update(parseServerInput(http({ headers: [{ name: "Authorization", value: "Bearer other", secret: true }] }))), McpStoreDisabled);
  assert.throws(() => store.create(parseServerInput(http({ name: "b", headers: [{ name: "Authorization", value: "x", secret: true }] }))), McpStoreDisabled);
  assert.equal(store.get("b"), undefined);
  // Keeping the stored secret needs no key; adding a plain header is fine.
  store.update(parseServerInput(http({ headers: [{ name: "Authorization", secret: true }, { name: "X-A", value: "1" }] })));
  assert.deepEqual(new McpServerStore(db, key).resolve("home")!.headers, { Authorization: TOKEN, "X-A": "1" });
  // Turning a stored plain value secret needs the key.
  assert.throws(() => store.update(parseServerInput(http({ headers: [{ name: "Authorization", secret: true }, { name: "X-A", secret: true }] }))), McpStoreDisabled);
});

test("resolve fails with value-free errors naming the entry", () => {
  const db = memDb();
  const store = new McpServerStore(db, key);
  store.create(withToken({ headers: [{ name: "Authorization", value: TOKEN, secret: true }, { name: "X-Other", value: "0ther-s3cret", secret: true }] }));
  const noSecret = (re: RegExp) => (e: unknown) => e instanceof Error && re.test(e.message) && !e.message.includes("s3cret");

  assert.throws(() => new McpServerStore(db, randomBytes(32)).resolve("home"), noSecret(/secret header "Authorization" cannot be decrypted/));
  assert.throws(() => new McpServerStore(db, undefined).resolve("home"), noSecret(/secret header "Authorization" requires FRIDAY_MASTER_KEY/));

  // AAD binds each ciphertext to its entry: swapping them breaks decryption.
  const get = (n: string) => db.prepare("SELECT ciphertext, iv, tag FROM mcp_server_headers WHERE name = ?").get(n) as { ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array };
  const a = get("Authorization");
  const b = get("X-Other");
  const put = db.prepare("UPDATE mcp_server_headers SET ciphertext = ?, iv = ?, tag = ? WHERE name = ?");
  put.run(b.ciphertext, b.iv, b.tag, "Authorization");
  put.run(a.ciphertext, a.iv, a.tag, "X-Other");
  assert.throws(() => store.resolve("home"), noSecret(/cannot be decrypted/));
});

test("delete removes the server and its entries", () => {
  const db = memDb();
  const store = new McpServerStore(db, key);
  store.create(withToken());
  assert.equal(store.delete("home"), true);
  assert.equal(store.delete("home"), false);
  assert.deepEqual(store.list(), []);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mcp_server_headers").get() as { n: number }).n, 0);
});
