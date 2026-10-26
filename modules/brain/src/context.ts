/**
 * The brain's prompt context (design D6, hybrid-profile D3): the user's instructions as directives, then
 * the memory as background: its instructions, the profile's summary and an index of recent pages.
 * The same for voice and chat, and bounded by the module itself below the platform's per-module cap.
 */
import { hint } from "./text.js";
import type { BrainStore, Page } from "./store.js";

/** The brain stays under this many characters (the platform cuts each module at 12000). */
export const CONTEXT_MAX = 10000;
/** Pages listed in the index. */
export const INDEX_MAX = 50;

const INSTRUCTIONS_INTRO = `## The user's instructions
These are the user's own standing instructions for you. Follow them unless the
user asks otherwise in the moment. They don't change how you use tools or how
you end a conversation.`;

const INTRO = `## Memory
You have a long-term memory about the user and their household. Use it as
background knowledge; don't recite it unprompted. Lines under "Notes" are
dated; when two contradict, the newer one holds. The profile is a summary
generated from the pages; the details about everything it names are on their
pages (brain_recall).`;

const PAGES_INTRO = `Call brain_recall before answering about any of these, or when the user
refers to something you might have noted before:`;

const OUTRO = `When the user asks you to remember something, or shares a lasting fact
about their life, call brain_remember.`;

const TRUNCATED = "(…profile cut here; the full text is in the portal)";

export function indexLine(p: Page): string {
  const meta = [p.type, ...(p.aliases.length ? [`aka ${p.aliases.join(", ")}`] : [])].join("; ");
  const h = hint(p.body);
  return `- ${p.name} (${meta})${h ? `: ${h}` : ""}`;
}

/**
 * Renders the context; never longer than `max` characters. The instructions are never cut (they are
 * bounded when saved); index entries go first, then the summary is cut at a line.
 */
export function renderContext(store: BrainStore, max = CONTEXT_MAX): string {
  const { body, instructions } = store.profile();
  const profile = body.trim();
  const directives = instructions?.trim() ? `${INSTRUCTIONS_INTRO}\n\n${instructions.trim()}\n\n` : "";
  const total = store.count();
  const entries = store.recent(INDEX_MAX).map(indexLine);

  const build = (profileText: string, lines: string[]) => {
    const more = total - lines.length;
    const pages = lines.length || more
      ? [PAGES_INTRO, ...lines, ...(more > 0 ? [`- …and ${more} more; brain_recall finds them by search.`] : [])].join("\n")
      : "(no pages yet)";
    return `${directives}${INTRO}\n\n### Profile\n${profileText || "(empty)"}\n\n### Pages\n${pages}\n\n${OUTRO}`;
  };

  let lines = entries;
  let text = build(profile, lines);
  // First drop index entries from the end…
  while (text.length > max && lines.length) {
    lines = lines.slice(0, -1);
    text = build(profile, lines);
  }
  // …then cut the profile at a line boundary.
  if (text.length > max) {
    const room = max - build("", []).length - TRUNCATED.length - 1;
    const kept: string[] = [];
    let used = 0;
    for (const line of profile.split("\n")) {
      if (used + line.length + 1 > room) break;
      kept.push(line);
      used += line.length + 1;
    }
    text = build(`${kept.join("\n")}${kept.length ? "\n" : ""}${TRUNCATED}`, []);
  }
  return text;
}
