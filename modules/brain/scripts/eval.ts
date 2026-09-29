/**
 * Opt-in quality check for the nightly pass (design D7): runs every fixture through the test host with the
 * real text model behind `ctx.llm`, and prints pass or fail per expectation. Not part of `pnpm test`.
 *
 *   pnpm --filter @friday/module-brain eval [fixture-name ...]
 *
 * Needs GEMINI_API_KEY (the repo's .env is read); FRIDAY_TEXT_MODEL picks the model (default gemini-flash-latest).
 */
import { GoogleGenAI } from "@google/genai";
import type { LlmRequest } from "@friday/sdk";
import { createTestHost } from "@friday/sdk/test";
import { createBrainModule } from "../src/index.js";
import { brainText, checkFixture, loadFixtures, seedFixture } from "../test/nightly/load.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is not set (put it in the repo's .env or the environment)");
  process.exit(2);
}
const model = process.env.FRIDAY_TEXT_MODEL || "gemini-flash-latest";
const ai = new GoogleGenAI({ apiKey });

/** The same call core's LlmService makes, without its queue and retries. */
async function gemini(req: LlmRequest): Promise<string> {
  const contents = req.messages
    ? req.messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] }))
    : [{ role: "user", parts: [{ text: req.prompt ?? "" }] }];
  const r = await ai.models.generateContent({
    model,
    contents,
    config: {
      systemInstruction: req.system,
      temperature: req.temperature,
      maxOutputTokens: req.maxOutputTokens,
      ...(req.schema ? { responseMimeType: "application/json", responseJsonSchema: req.schema } : {}),
    },
  });
  return r.text ?? "";
}

const only = process.argv.slice(2);
const fixtures = loadFixtures().filter((f) => !only.length || only.includes(f.name));
let passed = 0;
let failed = 0;
console.log(`nightly eval with ${model}: ${fixtures.length} fixtures\n`);
for (const fx of fixtures) {
  const calls: string[] = [];
  const h = await createTestHost(createBrainModule({ now: () => new Date("2026-09-30T01:00:00Z") }), {
    env: { FRIDAY_TIMEZONE: "Europe/Amsterdam", ...(fx.env ?? {}) },
    llm: async (req) => {
      calls.push((req.schema as { properties?: Record<string, unknown> })?.properties?.notes ? "extract" : "consolidate");
      return gemini(req);
    },
  });
  await seedFixture(h, fx);
  const before = brainText(h);
  const run = await h.runJob("nightly");
  const checks = checkFixture(h, fx, before);
  // Without this, a consolidation fixture whose plan was refused would pass by changing nothing.
  if (fx.kind === "consolidation") checks.unshift({ expectation: "a consolidation plan was applied", ok: !!run.summary && !/no consolidation applied|nothing to consolidate/.test(run.summary) });
  console.log(`${fx.name} (${fx.kind}): ${run.outcome}, ${run.summary ?? run.error ?? ""} [calls: ${calls.join(", ") || "none"}]`);
  for (const c of checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.expectation}`);
    if (c.ok) passed++;
    else failed++;
  }
  await h.dispose();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
