import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule, ToolRegistry } from "@friday/sdk";
import { ModuleHost } from "../src/module-host.js";
import { prompts, promptSettings, settings } from "../src/config.js";
import { createPromptContext, deviceBlock, systemPrompt } from "../src/prompt-context.js";

const quiet = { log() {}, warn() {}, error() {} };

test("the registry renders every module's context in load order, per channel", async () => {
  const prompt = createPromptContext({ log: quiet });
  const brain = defineModule({ manifest: { id: "brain", label: "Brain" }, init(ctx) { ctx.prompt.addContext(({ channel }) => `## Brain\nKnows things (${channel}).`); } });
  const media = defineModule({ manifest: { id: "media", label: "Media" }, init(ctx) { ctx.prompt.addContext(({ channel }) => (channel === "chat" ? "## Media\nLibrary: 120 films." : undefined)); } });
  const h = new ModuleHost(new ToolRegistry(quiet), { env: {}, log: quiet, prompt });
  await h.load([brain, media]);
  assert.equal(prompt.render("chat"), "## Brain\nKnows things (chat).\n\n## Media\nLibrary: 120 films.");
  assert.equal(prompt.render("voice"), "## Brain\nKnows things (voice).");
  assert.equal(systemPrompt(prompt, "voice")(), `${prompts.base}\n\n${prompts.voice}\n\n## Brain\nKnows things (voice).`);
  assert.equal(systemPrompt(prompt, "chat")(), `${prompts.base}\n\n${prompts.chat}\n\n## Brain\nKnows things (chat).\n\n## Media\nLibrary: 120 films.`);
  assert.equal(systemPrompt(undefined, "chat")(), settings.chatPrompt);
});

test("a device's voice prompt ends with its block: label, default area and notes", () => {
  const prompt = createPromptContext({ log: quiet });
  prompt.forOwner("brain").addContext(() => "## Brain\nKnows things.");
  const kitchen = { id: "friday-kitchen", label: "Kitchen satellite", area: "Kitchen", notes: "Next to the fridge" };
  const text = systemPrompt(prompt, "voice", kitchen)();
  assert.equal(text, `${prompts.base}\n\n${prompts.voice}\n\n## Brain\nKnows things.\n\n${deviceBlock(kitchen)}`);
  assert.ok(text.endsWith("Next to the fridge"));
  assert.match(deviceBlock(kitchen), /"Kitchen satellite"/);
  assert.match(deviceBlock(kitchen), /names no room, area or floor .*use the area "Kitchen"/);
});

test("a device without area or notes gets only its label, and sessions without a device get no block", () => {
  const bare = deviceBlock({ id: "friday-voice", label: "friday-voice", area: null, notes: null });
  assert.equal(bare, `## Where you are\nYou are speaking through the voice device "friday-voice".`);
  assert.doesNotMatch(bare, /area/);
  assert.equal(systemPrompt(undefined, "voice")(), settings.systemPrompt);
  assert.ok(!systemPrompt(undefined, "voice")().includes("## Where you are"));
  assert.equal(systemPrompt(undefined, "chat", { id: "x", label: "X", area: "Kitchen", notes: null })(), settings.chatPrompt, "chat never gets a device block");
});

test("the device block is the snapshot taken when the session opened", () => {
  const device = { id: "friday-kitchen", label: "Kitchen", area: "Kitchen", notes: null };
  const open = systemPrompt(undefined, "voice", { ...device });
  device.area = "Living room"; // the record changes; the session's snapshot does not
  assert.match(open(), /area "Kitchen"/);
  assert.match(systemPrompt(undefined, "voice", device)(), /area "Living room"/, "the next session uses the new area");
});

test("FRIDAY_PROMPT_CONTEXT_MAX_CHARS defaults to 12000 and caps each module", () => {
  assert.equal(promptSettings({}).promptContextMaxChars, 12000);
  assert.equal(promptSettings({ FRIDAY_PROMPT_CONTEXT_MAX_CHARS: "4000" }).promptContextMaxChars, 4000);
  assert.equal(promptSettings({ FRIDAY_PROMPT_CONTEXT_MAX_CHARS: "0" }).promptContextMaxChars, 12000);
  assert.equal(promptSettings({ FRIDAY_PROMPT_CONTEXT_MAX_CHARS: "lots" }).promptContextMaxChars, 12000);
  const warnings: string[] = [];
  const prompt = createPromptContext({ log: { ...quiet, warn: (...a: unknown[]) => void warnings.push(a.join(" ")) } });
  prompt.forOwner("brain").addContext(() => "x".repeat(20000));
  prompt.forOwner("media").addContext(() => "y".repeat(12000));
  const [brain, media] = prompt.render("voice").split("\n\n");
  assert.equal(brain.length, 12000);
  assert.ok(brain.endsWith("…"));
  assert.equal(media, "y".repeat(12000));
  assert.deepEqual(warnings, ["prompt context from brain is 20000 characters; cut to 12000"]);
});
