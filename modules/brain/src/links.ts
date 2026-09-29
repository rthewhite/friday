/**
 * Names and `[[links]]`: pure helpers without Node or database imports, shared by the store and the portal UI.
 * Links are always derived from page bodies, never stored.
 */

/** A page name compared the way the brain compares them: NFC, trimmed, whitespace collapsed, lower-cased. */
export function nameKey(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** `[[Name]]`: 1 to 80 characters without brackets or a newline. */
export const LINK_PATTERN = /\[\[([^[\]\n]{1,80})\]\]/g;

/** Longest context line reported for a link. */
export const LINE_MAX = 160;

export interface LinkRef {
  /** The target as written between the brackets, trimmed. */
  target: string;
  /** The line the link sits on, trimmed and cut to 160 characters. */
  line: string;
}

/** Every `[[link]]` in `body`, in order. */
export function parseLinks(body: string): LinkRef[] {
  const out: LinkRef[] = [];
  for (const raw of body.split("\n")) {
    const line = cutLine(raw.trim());
    for (const m of raw.matchAll(LINK_PATTERN)) {
      const target = m[1]!.trim();
      if (target) out.push({ target, line });
    }
  }
  return out;
}

/** Rewrites `[[X]]` to `X` wherever `nameKey(X)` is in `keys`; other links are left as they are. */
export function unlink(body: string, keys: ReadonlySet<string>): string {
  return body.replace(LINK_PATTERN, (whole, target: string) => (keys.has(nameKey(target)) ? target.trim() : whole));
}

function cutLine(line: string): string {
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
}
