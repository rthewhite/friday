import { test } from "node:test";
import assert from "node:assert/strict";
import { IntakeRejectedError, UpstreamError } from "../src/errors.js";
import { IntakeClient } from "../src/intake.js";
import { FakeIntake, INTAKE_KEY, INTAKE_URL } from "./fake-intake.js";

const client = (fetchImpl: typeof fetch, timeoutMs?: number) => new IntakeClient({ fetch: fetchImpl, config: () => ({ url: INTAKE_URL, key: INTAKE_KEY }), timeoutMs });

/** Rejects with what the poll threw, checking that the key never appears in it. */
async function failure(p: Promise<unknown>): Promise<Error> {
  const e = await p.then(() => assert.fail("expected the poll to fail"), (err: Error) => err);
  assert.ok(!e.message.includes(INTAKE_KEY), `the key leaked into: ${e.message}`);
  return e;
}

test("a poll is a POST with the bearer key and the calendar subject, refusing redirects", async () => {
  const intake = new FakeIntake();
  await client(intake.fetch).poll();
  const [req] = intake.requests;
  assert.equal(req.method, "POST");
  assert.equal(req.url, INTAKE_URL);
  assert.equal(req.headers.authorization, `Bearer ${INTAKE_KEY}`);
  assert.equal(req.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(req.body!), { subject: "calendar" });
  assert.equal(req.redirect, "manual");
});

test("a poll returns the waiting deliveries and the intake forgets them", async () => {
  const intake = new FakeIntake().load("v3");
  const first = await client(intake.fetch).poll();
  assert.equal(first.length, 1);
  assert.deepEqual(await client(intake.fetch).poll(), []);
});

test("a refused key is reported by name, without its value", async () => {
  const intake = new FakeIntake();
  intake.key = "something-else";
  const e = await failure(client(intake.fetch).poll());
  assert.ok(e instanceof IntakeRejectedError);
  assert.match(e.message, /refused INTAKE_KEY \(HTTP 401\)/);
  intake.respond = () => new Response("", { status: 403 });
  assert.ok((await failure(client(intake.fetch).poll())) instanceof IntakeRejectedError);
});

test("a redirect is not followed", async () => {
  const intake = new FakeIntake();
  intake.respond = () => new Response("", { status: 302, headers: { location: "http://elsewhere.example/steal" } });
  const e = await failure(client(intake.fetch).poll());
  assert.ok(e instanceof UpstreamError);
  assert.match(e.message, /redirect/);
  assert.deepEqual(intake.requests.map((r) => r.url), [INTAKE_URL]);
});

test("a poll gives up after its timeout", async () => {
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  const e = await failure(client(hanging, 20).poll());
  assert.ok(e instanceof UpstreamError);
  assert.match(e.message, /did not answer within/);
});

test("unreachable intakes, server errors and odd answers are UpstreamErrors", async () => {
  const down: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
  assert.match((await failure(client(down).poll())).message, /could not be reached/);
  const intake = new FakeIntake();
  intake.respond = () => new Response("oops", { status: 500 });
  assert.match((await failure(client(intake.fetch).poll())).message, /HTTP 500/);
  intake.respond = () => new Response("<html>", { status: 200 });
  assert.match((await failure(client(intake.fetch).poll())).message, /not JSON/);
  intake.respond = () => Response.json({ items: [] });
  assert.match((await failure(client(intake.fetch).poll())).message, /no "messages" array/);
  const bad = new IntakeClient({ fetch: intake.fetch, config: () => ({ url: "ftp://intake", key: INTAKE_KEY }) });
  assert.match((await failure(bad.poll())).message, /http or https/);
});
