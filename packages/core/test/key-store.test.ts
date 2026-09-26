import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvKeyStore, parseModuleKeys } from "../src/remote/key-store.js";

test("parses id=key pairs, tolerating spaces and trailing commas", () => {
  const s = new EnvKeyStore(" simracing=abc, lab=def ,");
  assert.equal(s.lookup("abc"), "simracing");
  assert.equal(s.lookup("def"), "lab");
  assert.equal(s.lookup("nope"), undefined);
  assert.equal(s.isEmpty(), false);
});

test("unset or empty means no keys", () => {
  assert.equal(new EnvKeyStore(undefined).isEmpty(), true);
  assert.equal(new EnvKeyStore("").lookup("x"), undefined);
});

test("malformed pairs throw", () => {
  assert.throws(() => parseModuleKeys("simracing"), /expected <id>=<key>/);
  assert.throws(() => parseModuleKeys("=abc"), /expected <id>=<key>/);
  assert.throws(() => parseModuleKeys("id="), /expected <id>=<key>/);
});

test("keys with = inside are kept whole", () => {
  assert.equal(parseModuleKeys("a=b=c").get("b=c"), "a");
});
