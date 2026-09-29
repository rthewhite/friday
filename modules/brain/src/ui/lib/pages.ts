/** Types and small helpers the brain UI shares between its pages. */
import { nameKey } from "../../links.js";
import { estimateTokens, fold, hint } from "../../text.js";
import { PAGE_TYPES, type PageType } from "../../types.js";

export { hint, estimateTokens, nameKey, PAGE_TYPES, type PageType };

export interface PageSummary {
  id: string;
  name: string;
  type: PageType;
  aliases: string[];
  body: string;
  isProfile: boolean;
  updatedAt: string;
  revisionId: number;
}

export interface PageList {
  profile: { id: string; usedTokens: number; budgetTokens: number; overBudget: boolean };
  pages: PageSummary[];
  deleted: { id: string; name: string; deletedAt: string }[];
}

export interface RevisionSummary {
  id: number;
  author: string;
  createdAt: string;
  note?: string;
  sources: string[];
}

export interface PageDetail extends PageSummary {
  createdAt: string;
  deletedAt?: string;
  revisions: RevisionSummary[];
  links: { target: string; line: string; pageId?: string; pageName?: string }[];
  backlinks: { pageId: string; name: string; line: string }[];
}

export interface RevisionDetail {
  id: number;
  author: string;
  name: string;
  type: PageType;
  aliases: string[];
  body: string;
  note?: string;
  sources: string[];
  createdAt: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string, readonly body: Record<string, unknown>) {
    super(message);
  }
}

/** JSON call to the brain's routes; non-2xx answers throw an `ApiError` carrying the body. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/modules/brain/${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, data.code as string | undefined, String(data.error ?? res.statusText), data);
  return data as T;
}

/** Whether a page matches the list's search box: every word in the name, aliases or body, ignoring case and accents. */
export function matches(page: Pick<PageSummary, "name" | "aliases" | "body">, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = fold([page.name, ...page.aliases, page.body].join("\n"));
  return words.every((w) => text.includes(w));
}

/** Aliases typed as a comma-separated list. */
export const parseAliases = (text: string): string[] => text.split(",").map((s) => s.trim()).filter(Boolean);
