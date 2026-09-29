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

/** Everything written as `[[…]]` outside code, including targets `LINK_PATTERN` rejects (too long, multi-line). */
export function looseLinkTargets(body: string): string[] {
  const out: string[] = [];
  mapText(body, (text) => {
    for (const m of text.matchAll(/\[\[([^[\]]+)\]\]/g)) out.push(m[1]!);
    return text;
  });
  return out;
}

/** Rewrites `[[X]]` outside code to `X` wherever `nameKey(X)` is in `keys`; other links are left as they are. */
export function unlink(body: string, keys: ReadonlySet<string>): string {
  return mapText(body, (text) => text.replace(LINK_PATTERN, (whole, target: string) => (keys.has(nameKey(target)) ? target.trim() : whole)));
}

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
