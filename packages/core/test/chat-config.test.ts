import { test } from "node:test";
import assert from "node:assert/strict";
import { chatSettings, prompts, settings } from "../src/config.js";

test("voice and chat prompts share the base; only voice mentions end_conversation", () => {
  assert.ok(settings.systemPrompt.startsWith(prompts.base));
  assert.ok(settings.chatPrompt.startsWith(prompts.base));
  assert.notEqual(settings.systemPrompt, settings.chatPrompt);
  assert.match(settings.systemPrompt, /end_conversation/);
  assert.doesNotMatch(settings.chatPrompt, /end_conversation/);
  assert.doesNotMatch(prompts.base, /end_conversation/);
  assert.match(prompts.chat, /Markdown/);
});

test("both prompts expect Dutch or English and treat other-sounding speech as misheard Dutch", () => {
  for (const prompt of [settings.systemPrompt, settings.chatPrompt]) {
    assert.match(prompt, /speaks Dutch or English/);
    assert.match(prompt, /answer in the language they speak/i);
    assert.match(prompt, /any other\s+language[\s\S]*misheard[\s\S]*treat it as Dutch/);
  }
});

test("the voice prompt forbids ending after a question or an invitation to talk", () => {
  assert.match(prompts.voice, /Never call end_conversation in a turn whose reply ends with a question\s+or invites the user to talk/);
  assert.match(prompts.voice, /invites you to chat[\s\S]*open conversation/);
});

test("chat model falls back to the text model; tool timeout defaults to 30 s", () => {
  assert.deepEqual(chatSettings({}), { chatModel: "gemini-flash-latest", chatToolTimeoutMs: 30000 });
  assert.equal(chatSettings({ FRIDAY_TEXT_MODEL: "gemini-3.8-flash" }).chatModel, "gemini-3.8-flash");
  assert.deepEqual(chatSettings({ FRIDAY_TEXT_MODEL: "a", FRIDAY_CHAT_MODEL: "b", FRIDAY_CHAT_TOOL_TIMEOUT_MS: "5000" }), { chatModel: "b", chatToolTimeoutMs: 5000 });
  assert.equal(chatSettings({ FRIDAY_CHAT_TOOL_TIMEOUT_MS: "0" }).chatToolTimeoutMs, 30000);
  assert.equal(chatSettings({ FRIDAY_CHAT_TOOL_TIMEOUT_MS: "nope" }).chatToolTimeoutMs, 30000);
});
