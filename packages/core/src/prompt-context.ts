/**
 * Module prompt context for core: one registry of every in-process module's providers, rendered in
 * module load order, and the system prompts built from it (voice when a session opens, chat per turn).
 */
import { composePrompt, PromptContext, type ConversationChannel, type ModuleLogger } from "@friday/sdk";
import { settings } from "./config.js";
import type { DeviceSnapshot } from "./devices/store.js";

export function createPromptContext(opts: { maxChars?: number; log?: ModuleLogger; now?: () => number } = {}): PromptContext {
  return new PromptContext({ maxChars: opts.maxChars ?? settings.promptContextMaxChars, log: opts.log, now: opts.now });
}

/**
 * Where a voice session's user is: the device they talk through, its Home Assistant area as the default for
 * requests that name no room (the HA tools take an area), and the household's notes about it.
 */
export function deviceBlock(device: DeviceSnapshot): string {
  const lines = ["## Where you are", `You are speaking through the voice device "${device.label}".`];
  if (device.area) {
    lines.push(
      `The user is in the Home Assistant area "${device.area}". When a request names no room, area or floor (for example "turn on the lights"), use the area "${device.area}".`,
    );
  }
  if (device.notes) lines.push(device.notes);
  return lines.join("\n");
}

/**
 * The channel's system prompt followed by the module context, rendered at each call, and for a voice session
 * from a registered device its device block (the snapshot taken when the connection was accepted).
 */
export function systemPrompt(context: Pick<PromptContext, "render"> | undefined, channel: ConversationChannel, device?: DeviceSnapshot): () => string {
  const base = channel === "voice" ? settings.systemPrompt : settings.chatPrompt;
  const where = channel === "voice" && device ? deviceBlock(device) : "";
  return () => composePrompt(composePrompt(base, context?.render(channel) ?? ""), where);
}
