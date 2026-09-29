/**
 * A line diff for the revision history. The common prefix and suffix are matched first, and the rest by
 * longest common subsequence; above `MAX_CELLS` table cells the middle is shown as removed then added,
 * so a huge body can't freeze the tab.
 */

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** Largest LCS table (rows × columns) the diff builds. */
export const MAX_CELLS = 2_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const same = (lines: string[]) => lines.map((text): DiffLine => ({ kind: "same", text }));
  return [...same(a.slice(0, start)), ...middle(a.slice(start, endA), b.slice(start, endB)), ...same(a.slice(endA))];
}

function middle(a: string[], b: string[]): DiffLine[] {
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return [...a.map((text): DiffLine => ({ kind: "del", text })), ...b.map((text): DiffLine => ({ kind: "add", text }))];
  }
  // lcs[i][j]: length of the common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i++]! });
    } else {
      out.push({ kind: "add", text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}
