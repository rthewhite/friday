/**
 * Runs core's live tests (named `live: ...`) against the real Gemini API: `pnpm --filter @friday/core test:live`.
 * Unlike `pnpm test`, which skips them, this fails without GEMINI_API_KEY (environment or packages/core/.env), and
 * fails when no live test passed, so a renamed test can't turn the weekly run green by matching nothing.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

if (!process.env.GEMINI_API_KEY) {
  console.error("test:live: GEMINI_API_KEY is not set (environment or packages/core/.env)");
  process.exit(2);
}

const run = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-reporter=spec", "--test-name-pattern=^live: ", "test/*.test.ts"],
  { env: { ...process.env, FRIDAY_LIVE_TESTS: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
process.stdout.write(run.stdout ?? "");
if (run.status !== 0) process.exit(run.status ?? 1);

// Colour (FORCE_COLOR on CI runners) and a `describe` around the tests must not hide a pass from the count.
const ran = (stripVTControlCharacters(run.stdout).match(/^\s*✔ live: /gm) ?? []).length;
if (ran === 0) {
  console.error("test:live: no live test ran; were the `live: ` tests renamed?");
  process.exit(1);
}
console.log(`test:live: ${ran} live test(s) passed`);
