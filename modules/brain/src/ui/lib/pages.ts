/** Types and small helpers the brain UI shares between its pages. */
import { nameKey } from "../../links.js";
import { estimateTokens, fold, hint } from "../../text.js";
import { INSTRUCTIONS_MAX, PAGE_TYPES, unnamedSubject, type PageType } from "../../types.js";

export { hint, estimateTokens, nameKey, INSTRUCTIONS_MAX, PAGE_TYPES, unnamedSubject, type PageType };

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
  profile: { id: string; usedTokens: number; budgetTokens: number; overBudget: boolean; instructions: string; subjectId: string };
  pages: PageSummary[];
  deleted: { id: string; name: string; deletedAt: string }[];
}


/**
 * The list as the brain page shows it: the profile pinned first, the user's page second, then the other
 * pages matching the search box (in the API's order, most recently updated first).
 */
export function arrangePages(list: PageList, query: string): { profile?: PageSummary; subject?: PageSummary; others: PageSummary[] } {
  return {
    profile: list.pages.find((p) => p.isProfile),
    subject: list.pages.find((p) => p.id === list.profile.subjectId),
    others: list.pages.filter((p) => !p.isProfile && p.id !== list.profile.subjectId && matches(p, query)),
  };
}

export interface RevisionSummary {
  id: number;
  author: string;
  /** Who made a portal edit (author `user`), when known. */
  user?: { id: string; name: string };
  createdAt: string;
  note?: string;
  sources: string[];
}

export interface PageDetail extends PageSummary {
  /** The profile only: the user's instructions, and the id of the user's page. */
  instructions?: string;
  subjectId?: string;
  /** This is the user's own page. */
  isSubject: boolean;
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
  /** Profile revisions only. */
  instructions?: string;
  note?: string;
  sources: string[];
  createdAt: string;
}

export interface RunSummary {
  id: number;
  trigger: string;
  startedAt: string;
  finishedAt?: string;
  outcome?: "ok" | "partial" | "failed";
  summary?: string;
  error?: string;
}

export interface RunPageView {
  pageId: string;
  name: string;
  deleted: boolean;
  before?: RevisionDetail;
  after: RevisionDetail;
  authors: string[];
  sources: { id: string; exists: boolean }[];
  dropped: { line: string; reason: string }[];
  mergedInto?: string;
  mergedFrom?: string;
  currentRevisionId: number;
  changedSince: boolean;
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

/**
 * Runs the nightly pass now, for the logged-in user's own brain only: "started", or "running" when a pass for
 * their brain is already going. Any user may, also while the schedule is off.
 */
export async function runNightlyNow(fetchFn: typeof fetch = fetch): Promise<"started" | "running"> {
  const res = await fetchFn("/api/modules/brain/runs/now", { method: "POST" });
  if (res.status === 409) return "running";
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(res.status, data.code as string | undefined, String(data.error ?? res.statusText), data);
  }
  return "started";
}

/** When the profile's summary was last written by the nightly pass: its newest `consolidation` revision. */
export const summaryGeneratedAt = (revisions: RevisionSummary[]): string | undefined => revisions.find((r) => r.author === "consolidation")?.createdAt;

/** Aliases typed as a comma-separated list. */
export const parseAliases = (text: string): string[] => text.split(",").map((s) => s.trim()).filter(Boolean);
