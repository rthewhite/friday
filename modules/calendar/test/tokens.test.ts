import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenError } from "../src/errors.js";
import { TOKEN_TTL_MS, TokenStore, type PendingChange } from "../src/tokens.js";

const change = { action: "delete", calendarId: "home", before: { url: "u", etag: '"1"', ics: "" }, ics: null, title: "x" } as unknown as PendingChange;

function store() {
  const c = { t: 0 };
  return { c, tokens: new TokenStore(() => new Date(c.t)) };
}

test("a token is six characters, lasts five minutes and works once", () => {
  const { tokens } = store();
  const { token, expiresInSeconds } = tokens.issue(change);
  assert.match(token, /^[a-z2-9]{6}$/);
  assert.equal(expiresInSeconds, 300);
  assert.equal(tokens.take(token), change);
  assert.throws(() => tokens.take(token), (e: unknown) => e instanceof TokenError && /already used/.test(e.message) && /Preview the change again/.test(e.message));
});

test("an expired token is refused", () => {
  const { c, tokens } = store();
  const { token } = tokens.issue(change);
  c.t += TOKEN_TTL_MS;
  assert.throws(() => tokens.take(token), (e: unknown) => e instanceof TokenError && /expired/.test(e.message));
});

test("unknown and missing tokens are refused; matching ignores case and spaces", () => {
  const { tokens } = store();
  assert.throws(() => tokens.take("zzzzzz"), TokenError);
  assert.throws(() => tokens.take(undefined), TokenError);
  const { token } = tokens.issue(change);
  assert.equal(tokens.take(` ${token.toUpperCase()} `), change);
});
