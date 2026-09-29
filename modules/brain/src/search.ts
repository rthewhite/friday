/**
 * Search for `brain_recall` (design D4): a full scan over a household-sized brain. Terms are folded
 * (case and accents), short words and English/Dutch stopwords are dropped, and a page scores one point
 * per distinct term in its body, or two when the term is in its name or aliases.
 */
import type { Page } from "./store.js";
import { fold } from "./text.js";

export { fold };

/** Longest query the search considers, in distinct words. */
export const MAX_TERMS = 8;

// Only words of 3+ characters matter: shorter ones are dropped anyway.
const STOPWORDS = new Set(
  (
    // English
    "the and for are but not you your yours all any can could had has have her hers him his how its our ours out who whom " +
    "what when where which why with this that these those from they them their theirs there then than been were was will " +
    "would should shall does did doing done about into onto over under again also just some such only very more most other " +
    "each few own same too off once here both being having does very let lets tell told know about please something anything " +
    // Dutch
    "een het van dat die niet zijn voor met ook maar als bij nog wel wat wie waar hoe dan naar heb hebt heeft hebben had " +
    "waren wordt worden werd kan kun kunt kunnen moet moeten zal zult zullen zou zouden zich deze dit haar hun mijn jouw " +
    "onze jullie uit over door tot toch hier daar geen veel meer iets niets alle alles heel dus want omdat welke wanneer " +
    "waarom wij jij zij hij ons mij jou hem ben bent zo sinds tegen onder boven even eens graag weet weten vertel"
  ).split(/\s+/),
);

/** The distinct search terms of the inputs: folded words longer than 2 characters, stopwords removed, at most 8. */
export function searchTerms(...inputs: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    for (const word of fold(input ?? "").split(/[^\p{L}\p{N}]+/u)) {
      if (word.length <= 2 || STOPWORDS.has(word) || out.includes(word)) continue;
      out.push(word);
      if (out.length === MAX_TERMS) return out;
    }
  }
  return out;
}

/** One point per term found in the body, two when found in the name or an alias. */
export function score(page: Pick<Page, "name" | "aliases" | "body">, terms: string[]): number {
  const names = fold([page.name, ...page.aliases].join("\n"));
  const body = fold(page.body);
  let s = 0;
  for (const t of terms) {
    if (names.includes(t)) s += 2;
    else if (body.includes(t)) s += 1;
  }
  return s;
}

/**
 * Live pages other than the profile that match, best first (ties: most recently updated). `pages`
 * may contain deleted pages and the profile; they are skipped.
 */
export function search(pages: Page[], terms: string[]): { page: Page; score: number }[] {
  if (!terms.length) return [];
  return pages
    .filter((p) => !p.isProfile && !p.deletedAt)
    .map((page) => ({ page, score: score(page, terms) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || b.page.updatedAt.localeCompare(a.page.updatedAt));
}
