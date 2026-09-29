/**
 * Module prompt context for core: one registry of every in-process module's providers, rendered in
 * module load order, and the system prompts built from it (voice when a session opens, chat per turn).
 */
import { composePrompt, PromptContext, type ConversationChannel, type ModuleLogger } from "@friday/sdk";
import { settings } from "./config.js";

export function createPromptContext(opts: { maxChars?: number; log?: ModuleLogger; now?: () => number } = {}): PromptContext {
  return new PromptContext({ maxChars: opts.maxChars ?? settings.promptContextMaxChars, log: opts.log, now: opts.now });
}

/** The channel's system prompt followed by the module context, rendered at each call. */
export function systemPrompt(context: Pick<PromptContext, "render"> | undefined, channel: ConversationChannel): () => string {
  const base = channel === "voice" ? settings.systemPrompt : settings.chatPrompt;
  return () => composePrompt(base, context?.render(channel) ?? "");
}
