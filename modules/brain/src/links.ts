/**
 * Names and `[[links]]`: pure helpers without Node or database imports, shared by the store and the portal UI.
 * Links are always derived from page bodies, never stored. Text in code (fenced blocks and inline code
 * spans) is not a link, as in the rendered page.
 */

/** A page name compared the way the brain compares them: NFC, trimmed, whitespace collapsed, lower-cased. */
export function nameKey(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** `[[Name]]`: 1 to 80 characters without brackets or a newline. */
export const LINK_PATTERN = /\[\[([^[\]\n]{1,80})\]\]/g;

/** Whether the text between `[[` and `]]` is a link target (the same rule as `LINK_PATTERN`). */
export const isLinkTarget = (target: string): boolean => target.length >= 1 && target.length <= 80 && !/[[\]\n]/.test(target) && target.trim() !== "";

/** Longest context line reported for a link. */
export const LINE_MAX = 160;

export interface LinkRef {
  /** The target as written between the brackets, trimmed. */
  target: string;
  /** The line the link sits on, trimmed and cut to 160 characters. */
  line: string;
}

/** Every `[[link]]` in `body` outside code, in order. */
export function parseLinks(body: string): LinkRef[] {
  const out: LinkRef[] = [];
  mapText(body, (text, raw) => {
    const line = cutLine(raw.trim());
    for (const m of text.matchAll(LINK_PATTERN)) {
      const target = m[1]!.trim();
      if (target) out.push({ target, line });
    }
    return text;
  });
  return out;
}

/** Rewrites `[[X]]` outside code to `X` wherever `nameKey(X)` is in `keys`; other links are left as they are. */
export function unlink(body: string, keys: ReadonlySet<string>): string {
  return mapText(body, (text) => text.replace(LINK_PATTERN, (whole, target: string) => (keys.has(nameKey(target)) ? target.trim() : whole)));
}

/** A page name or alias that `autolink` may link. */
export interface LinkName {
  name: string;
  pageId: string;
}

/** Names shorter than this are never linked automatically ("Me" would match too much). */
export const AUTOLINK_MIN = 3;

/** Text `autolink` leaves alone: `[[links]]`, markdown links, `<autolinks>` and bare URLs. */
const PROTECTED = new RegExp(`${LINK_PATTERN.source}|\\[[^\\]\\n]*\\]\\([^)\\n]*\\)|<[^>\\n]*>|\\b[a-z][a-z0-9+.-]*:\\/\\/\\S+`, "gi");
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;

/**
 * Links the first mention of each page in `text` (hybrid-profile D7): a whole-word, case-sensitive
 * occurrence of one of its names or aliases becomes `[[occurrence]]`. Code, existing links, markdown links,
 * URLs and headings are left alone, and so is a name followed by another capitalized word ("Home" in
 * "Home Assistant"). Longer names go first, so "Honda CB900F" wins over "Honda". Pages in `linked` (already
 * linked in the body) are skipped, and so is a page once one of its names was linked.
 */
export function autolink(text: string, names: readonly LinkName[], linked: ReadonlySet<string> = new Set()): string {
  const done = new Set(linked);
  const candidates = names.filter((n) => n.name.trim().length >= AUTOLINK_MIN).sort((a, b) => b.name.length - a.name.length);
  let out = text;
  for (const { name, pageId } of candidates) {
    if (done.has(pageId)) continue;
    const word = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name.trim())}(?![\\p{L}\\p{N}_])(?![ \\t]+\\p{Lu})`, "u");
    let found = false;
    const linkFirst = (part: string): string => {
      const m = found ? null : word.exec(part);
      if (!m) return part;
      found = true;
      return `${part.slice(0, m.index)}[[${m[0]}]]${part.slice(m.index + m[0].length)}`;
    };
    out = mapText(out, (segment, line) => {
      if (HEADING.test(line)) return segment;
      // Only the parts between protected text: never inside a link or a URL.
      let result = "";
      let last = 0;
      for (const m of segment.matchAll(PROTECTED)) {
        result += linkFirst(segment.slice(last, m.index)) + m[0];
        last = m.index + m[0].length;
      }
      return result + linkFirst(segment.slice(last));
    });
    if (found) done.add(pageId);
  }
  return out;
}

/** `s` matched literally inside a regular expression. */
export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Applies `fn` to the parts of `body` that are not code: lines inside ``` or ~~~ fences, and inline
 * code spans (a run of backticks up to the same run), are passed through unchanged. `fn` also gets
 * the whole line the text sits on.
 */
function mapText(body: string, fn: (text: string, line: string) => string): string {
  let fence: string | undefined;
  return body
    .split("\n")
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      let out = "";
      let text = 0;
      let i = 0;
      while (i < line.length) {
        if (line[i] !== "`") { i++; continue; }
        const run = runAt(line, i);
        // The span closes at the next run of exactly the same length; without one the backticks are literal.
        let j = i + run;
        let close = -1;
        while (j < line.length) {
          if (line[j] !== "`") { j++; continue; }
          const r = runAt(line, j);
          if (r === run) { close = j; break; }
          j += r;
        }
        if (close === -1) { i += run; continue; }
        out += fn(line.slice(text, i), line) + line.slice(i, close + run);
        i = text = close + run;
      }
      return out + fn(line.slice(text), line);
    })
    .join("\n");
}

/** Length of the backtick run starting at `i`. */
function runAt(line: string, i: number): number {
  let n = 0;
  while (line[i + n] === "`") n++;
  return n;
}

function cutLine(line: string): string {
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
}
