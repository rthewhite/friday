import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentPrompt, agentSettings, chatSettings, prompts, settings } from "../src/config.js";

test("voice and chat prompts share the base; only voice mentions end_conversation", () => {
  assert.ok(settings.systemPrompt.startsWith(prompts.base));
  assert.ok(settings.chatPrompt.startsWith(prompts.base));
  assert.notEqual(settings.systemPrompt, settings.chatPrompt);
  assert.match(settings.systemPrompt, /end_conversation/);
  assert.doesNotMatch(settings.chatPrompt, /end_conversation/);
  assert.doesNotMatch(prompts.base, /end_conversation/);
  assert.match(prompts.chat, /Markdown/);
});

test("both prompts expect Dutch or English; only voice treats other-sounding speech as misheard Dutch", () => {
  for (const prompt of [settings.systemPrompt, settings.chatPrompt]) {
    assert.match(prompt, /speaks Dutch or English/);
    assert.match(prompt, /answer in the language they speak/i);
    assert.match(prompt, /unless\s+they\s+ask\s+for\s+another\s+language/);
  }
  assert.match(prompts.voice, /whole\s+utterance[\s\S]*other\s+than\s+Dutch\s+or\s+English[\s\S]*misheard[\s\S]*treat it as Dutch/);
  assert.match(prompts.voice, /names, titles\s+and quoted words/i);
  // Typing can't be misheard: a message typed in German is answered in German.
  assert.doesNotMatch(prompts.base, /misheard/);
  assert.doesNotMatch(settings.chatPrompt, /misheard/);
});

test("the voice prompt forbids ending after a question or an invitation to talk", () => {
  assert.match(prompts.voice, /Never call end_conversation in a turn whose reply ends with a question\s+or invites the user to talk/);
  assert.match(prompts.voice, /invites you to chat[\s\S]*open conversation/);
});

test("the voice prompt makes a time of day an alarm, corrections a change, and confirmations a list_alerts call", () => {
  assert.match(prompts.voice, /time of day[\s\S]*is an alarm: call\s+set_alarm[\s\S]*set_timer only for a length of time[\s\S]*Never work out seconds/);
  assert.match(prompts.voice, /corrects or changes[\s\S]*call change_alert\.\s+Never set a second one[\s\S]*ask whether it should go/);
  assert.match(prompts.voice, /confirm one, call list_alerts/);
  assert.match(prompts.voice, /from the `when` the tool returned/);
  // Chat has no device and none of these tools.
  assert.doesNotMatch(settings.chatPrompt, /set_alarm|change_alert|list_alerts/);
});

test("an agent's prompt names it, the local weekday, date, time and zone, the unattended and approval rules, then its instructions", () => {
  // 17:30 UTC on Sunday 25 October 2026 is 18:30 in Amsterdam (winter time from that morning).
  const p = agentPrompt("weekly-review", "Look at this week's calendar.", new Date("2026-10-25T17:30:00Z"), "Europe/Amsterdam");
  assert.match(p, /^You are "weekly-review", an agent of Friday/);
  assert.ok(p.includes("It is now Sunday, 25 October 2026 at 18:30 (Europe/Amsterdam)."));
  assert.match(p, /You run unattended: nobody reads what you write until the run is over/);
  assert.match(p, /queued for the user's approval\. Carry on without that\s+call's result/);
  assert.match(p, /That answer is the run's\s+summary/);
  assert.ok(p.endsWith("Your instructions:\n\nLook at this week's calendar."));
  // Agents are not Friday's voice or chat persona.
  assert.doesNotMatch(p, /end_conversation|Markdown/);
});

test("agent tool calls time out after 60 s unless FRIDAY_AGENT_TOOL_TIMEOUT_MS says otherwise; it is documented", () => {
  assert.deepEqual(agentSettings({}), { agentToolTimeoutMs: 60000 });
  assert.equal(agentSettings({ FRIDAY_AGENT_TOOL_TIMEOUT_MS: "5000" }).agentToolTimeoutMs, 5000);
  assert.equal(agentSettings({ FRIDAY_AGENT_TOOL_TIMEOUT_MS: "0" }).agentToolTimeoutMs, 60000);
  assert.equal(agentSettings({ FRIDAY_AGENT_TOOL_TIMEOUT_MS: "nope" }).agentToolTimeoutMs, 60000);
  const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
  assert.ok(example.includes("FRIDAY_AGENT_TOOL_TIMEOUT_MS=60000"));
});

test("chat model falls back to the text model; tool timeout defaults to 30 s", () => {
  assert.deepEqual(chatSettings({}), { chatModel: "gemini-flash-latest", chatToolTimeoutMs: 30000 });
  assert.equal(chatSettings({ FRIDAY_TEXT_MODEL: "gemini-3.8-flash" }).chatModel, "gemini-3.8-flash");
  assert.deepEqual(chatSettings({ FRIDAY_TEXT_MODEL: "a", FRIDAY_CHAT_MODEL: "b", FRIDAY_CHAT_TOOL_TIMEOUT_MS: "5000" }), { chatModel: "b", chatToolTimeoutMs: 5000 });
  assert.equal(chatSettings({ FRIDAY_CHAT_TOOL_TIMEOUT_MS: "0" }).chatToolTimeoutMs, 30000);
  assert.equal(chatSettings({ FRIDAY_CHAT_TOOL_TIMEOUT_MS: "nope" }).chatToolTimeoutMs, 30000);
});
