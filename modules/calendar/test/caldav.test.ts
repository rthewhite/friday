import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModuleLogger } from "@friday/sdk";
import { CalDavClient, utcStamp, type Credentials } from "../src/caldav.js";
import { CredentialRejectedError, PreconditionFailed, ReadOnlyError, UpstreamError } from "../src/errors.js";
import { CAL, FakeICloud, PASSWORD, USERNAME, timed, vcalendar } from "./fake-icloud.js";

function setup(fake = new FakeICloud(), creds: Credentials = { username: USERNAME, password: PASSWORD }) {
  const lines: string[] = [];
  const log: ModuleLogger = { log: (...a) => lines.push(a.join(" ")), warn: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
  const client = new CalDavClient({ fetch: fake.fetch, credentials: () => creds, log });
  return { fake, client, creds, lines };
}

const EVENT = vcalendar(timed("dentist", "Dentist", "20261008T140000", "20261008T150000"));

test("discovery lists event calendars only, with names, colours and writability", async () => {
  const { client } = setup();
  const account = await client.discover();
  assert.equal(account.username, USERNAME);
  assert.deepEqual(account.addresses, ["me@example.com", "me@icloud.com"]);
  assert.deepEqual(
    account.calendars.map((c) => ({ id: c.id, name: c.name, color: c.color, writable: c.writable })),
    [
      { id: "home", name: "Home", color: "#1badf8", writable: true },
      { id: "work", name: "Work", color: "#ff2968", writable: true },
      { id: "holidays", name: "Holidays NL", color: undefined, writable: false },
    ],
  );
  assert.equal(account.calendars[0].url, CAL("home"));
});

test("a calendar without a privilege set counts as writable", async () => {
  const { client } = setup(new FakeICloud({ calendars: [{ id: "shared", name: "Family" }] }));
  const [cal] = (await client.discover()).calendars;
  assert.equal(cal.writable, true);
});

test("principal and home are discovered once per username; the calendar list every time", async () => {
  const { client, fake, creds } = setup();
  await client.discover();
  await client.discover();
  const propfinds = () => fake.requests.filter((r) => r.method === "PROPFIND").map((r) => new URL(r.url).pathname);
  assert.deepEqual(propfinds(), ["/", "/1234567/principal/", "/1234567/calendars/", "/1234567/calendars/"]);
  creds.username = "other@icloud.com";
  fake.requests.length = 0;
  await assert.rejects(client.discover(), CredentialRejectedError);
  assert.deepEqual(propfinds(), ["/"]);
});

test("a range query sends a UTC time-range and returns each object's ICS and ETag", async () => {
  const { client, fake } = setup();
  const url = fake.seed("home", "dentist", EVENT);
  const from = new Date("2026-10-08T00:00:00+02:00"), to = new Date("2026-10-09T00:00:00+02:00");
  const objects = await client.query(CAL("home"), from, to);
  assert.equal(objects.length, 1);
  assert.equal(objects[0].url, url);
  assert.equal(objects[0].etag, fake.objects.get(url)!.etag);
  assert.match(objects[0].ics, /SUMMARY:Dentist/);
  const report = fake.requests.find((r) => r.method === "REPORT")!;
  assert.match(report.body!, /start="20261007T220000Z" end="20261008T220000Z"/);
  assert.equal(report.headers.depth, "1");
  assert.equal(utcStamp(from), "20261007T220000Z");
});

test("an empty calendar answers an empty multistatus and returns no objects", async () => {
  const { client } = setup();
  assert.deepEqual(await client.query(CAL("work"), new Date(0), new Date(1)), []);
});

test("put creates with If-None-Match, updates with If-Match, and returns the new ETag", async () => {
  const { client, fake } = setup();
  const url = `${CAL("home")}new.ics`;
  const etag = await client.put(url, EVENT, null);
  assert.equal(fake.objects.get(url)!.etag, etag);
  assert.equal(fake.writes()[0].headers["if-none-match"], "*");
  const etag2 = await client.put(url, EVENT.replace("Dentist", "Dentist (moved)"), etag);
  assert.notEqual(etag2, etag);
  assert.equal(fake.writes()[1].headers["if-match"], etag);
});

test("a PUT answered without an ETag reads the ETag back", async () => {
  const { client, fake } = setup(new FakeICloud({ putWithoutEtag: true }));
  const url = `${CAL("home")}new.ics`;
  const etag = await client.put(url, EVENT, null);
  assert.equal(etag, fake.objects.get(url)!.etag);
  assert.equal(fake.requests.at(-1)!.method, "GET");
});

test("conditional writes on a changed or missing object throw PreconditionFailed", async () => {
  const { client, fake } = setup();
  const url = fake.seed("home", "dentist", EVENT);
  const stale = fake.objects.get(url)!.etag;
  fake.touch(url);
  await assert.rejects(client.put(url, EVENT, stale), PreconditionFailed);
  await assert.rejects(client.delete(url, stale), PreconditionFailed);
  await assert.rejects(client.put(`${CAL("home")}gone.ics`, EVENT, stale), PreconditionFailed);
  await assert.rejects(client.put(url, EVENT, null), PreconditionFailed);
});

test("a write to a read-only calendar is a ReadOnlyError", async () => {
  const { client } = setup();
  await assert.rejects(client.put(`${CAL("holidays")}x.ics`, EVENT, null), ReadOnlyError);
});

test("get returns null for a missing object", async () => {
  const { client } = setup();
  assert.equal(await client.get(`${CAL("home")}nope.ics`), null);
});

test("a 401 is a credential error naming the username and how to fix it, never the password", async () => {
  const { client, lines } = setup(new FakeICloud({ password: "the-real-one" }));
  const err = await client.discover().then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof CredentialRejectedError);
  assert.match(err.message, /me@icloud\.com/);
  assert.match(err.message, /app-specific password/);
  assert.match(err.message, /account\.apple\.com/);
  assert.ok(!err.message.includes(PASSWORD));
  assert.ok(!lines.join("\n").includes(PASSWORD));
});

test("credentials are read per request, so a corrected password works at once", async () => {
  const { client, creds } = setup();
  creds.password = "wrong";
  await assert.rejects(client.discover(), CredentialRejectedError);
  creds.password = PASSWORD;
  assert.equal((await client.discover()).calendars.length, 3);
});

test("redirects are followed, but the Basic header never leaves *.icloud.com", async () => {
  const internal = setup(new FakeICloud({ redirectPrincipalTo: "https://caldav.icloud.com/" }));
  assert.equal((await internal.client.discover()).calendars.length, 3);

  const fake = new FakeICloud({ redirectPrincipalTo: "https://evil.example.com/steal" });
  const { client } = setup(fake);
  await assert.rejects(client.discover(), UpstreamError);
  const offsite = fake.requests.find((r) => r.url.startsWith("https://evil.example.com/"));
  assert.ok(offsite, "the redirect was followed");
  assert.equal(offsite.headers.authorization, undefined);
});

test("network failures and server errors are UpstreamErrors without URLs or the password", async () => {
  const fake = new FakeICloud();
  const { client, lines } = setup(fake);
  fake.failWith = 0;
  const net = await client.discover().then(() => undefined, (e: unknown) => e);
  assert.ok(net instanceof UpstreamError);
  assert.match(net.message, /could not be reached/);
  fake.failWith = 503;
  const busy = await client.discover().then(() => undefined, (e: unknown) => e);
  assert.ok(busy instanceof UpstreamError);
  assert.match(busy.message, /busy/);
  for (const text of [net.message, busy.message, ...lines]) {
    assert.ok(!text.includes("icloud.com/"), text);
    assert.ok(!text.includes(PASSWORD), text);
  }
});
