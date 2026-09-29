/** Small text helpers shared by the prompt context and the portal UI (no Node or database imports). */

/** Lower-cased, accents stripped: how search compares text (brain_recall and the portal's search box). */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** The profile budget's token estimate: characters divided by 4, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Longest hint shown for a page in the prompt index and the portal list. */
export const HINT_MAX = 80;

/**
 * A one-line summary of a body: its first non-empty line that is not a heading, with markdown
 * markers (list bullets, quotes, emphasis, link brackets) removed and cut to 80 characters.
 */
export function hint(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || /^#{1,6}(\s|$)/.test(line)) continue;
    const text = line
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/, "")
      .replace(/\[\[([^[\]\n]+)\]\]/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]+/g, "")
      .trim();
    if (!text) continue;
    return text.length > HINT_MAX ? `${text.slice(0, HINT_MAX - 1)}…` : text;
  }
  return "";
}
