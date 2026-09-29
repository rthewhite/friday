/** HTTP routes under /api/modules/brain/ (design D7). The portal is the only place memories are deleted. */
import type { ModuleContext, RouteRequest, RouteResponse } from "@friday/sdk";
import { estimateTokens } from "./text.js";
import { BrainError, type BrainErrorCode, type BrainStore, type Page, type PageFields } from "./store.js";

const STATUS: Record<BrainErrorCode, number> = {
  invalid: 400,
  profile: 400,
  not_found: 404,
  name_taken: 409,
  stale: 409,
  tombstoned: 409,
  not_deleted: 409,
};

export type Handler = (req: RouteRequest, res: RouteResponse, params: Record<string, string>) => void | Promise<void>;

/** Store errors become `{ error, code }` (plus `current` for `stale`, `names` for collisions). */
export const handle = (fn: Handler): Handler => async (req, res, params) => {
  try {
    await fn(req, res, params);
  } catch (e) {
    if (!(e instanceof BrainError)) throw e;
    res.status(STATUS[e.code]).json({ error: e.message, code: e.code, ...(e.current ? { current: e.current } : {}), ...(e.names ? { names: e.names } : {}) });
  }
};

export async function body<T extends object>(req: RouteRequest): Promise<Partial<T>> {
  let b: unknown;
  try {
    b = await req.json();
  } catch {
    throw new BrainError("invalid", "the body must be JSON");
  }
  if (b === undefined) return {};
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw new BrainError("invalid", "the body must be a JSON object");
  return b as Partial<T>;
}

export const revisionNumber = (v: unknown, what: string): number => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) throw new BrainError("invalid", `${what} must be a revision number`);
  return n;
};

const summary = (p: Page) => ({ id: p.id, name: p.name, type: p.type, aliases: p.aliases, body: p.body, isProfile: p.isProfile, updatedAt: p.updatedAt, revisionId: p.revisionId });

export function registerBrainRoutes(ctx: ModuleContext, store: BrainStore, budget: () => number): void {
  const route = (method: Parameters<ModuleContext["http"]["route"]>[0], path: string, fn: Handler) => ctx.http.route(method, path, handle(fn));
  const found = (id: string): Page => {
    const p = store.get(id);
    if (!p) throw new BrainError("not_found", "no such page");
    return p;
  };

  route("GET", "pages", (_req, res) => {
    const profile = store.profile();
    const used = estimateTokens(profile.body);
    const budgetTokens = budget();
    res.json({
      profile: { id: profile.id, usedTokens: used, budgetTokens, overBudget: used > budgetTokens },
      pages: store.list().map(summary),
      deleted: store.deleted().map((p) => ({ id: p.id, name: p.name, deletedAt: p.deletedAt })),
    });
  });

  route("GET", "pages/:id", (_req, res, { id }) => {
    const page = found(id);
    res.json({ ...page, revisions: store.revisions(id), links: store.links(page), backlinks: page.deletedAt ? [] : store.backlinks(page) });
  });

  route("GET", "pages/:id/revisions/:rev", (_req, res, { id, rev }) => {
    found(id);
    const r = store.revision(id, revisionNumber(rev, "rev"));
    if (!r) throw new BrainError("not_found", "no such revision");
    res.json(r);
  });

  route("POST", "pages", async (req, res) => {
    const b = await body<PageFields>(req);
    res.status(201).json(store.create({ name: b.name, type: b.type, aliases: b.aliases, body: b.body }, "user"));
  });

  route("PUT", "pages/:id", async (req, res, { id }) => {
    const b = await body<PageFields & { baseRevision: number; keepOldName: boolean }>(req);
    const base = revisionNumber(b.baseRevision, "baseRevision");
    res.json(store.save(id, { name: b.name, type: b.type, aliases: b.aliases, body: b.body }, "user", { base, keepOldName: b.keepOldName !== false }));
  });

  route("POST", "pages/:id/restore", async (req, res, { id }) => {
    const b = await body<{ revisionId: number; baseRevision: number }>(req);
    res.json(store.restore(id, revisionNumber(b.revisionId, "revisionId"), "user", revisionNumber(b.baseRevision, "baseRevision")));
  });

  route("DELETE", "pages/:id", (_req, res, { id }) => {
    store.softDelete(id, "user");
    res.status(204);
  });

  route("POST", "pages/:id/undelete", (_req, res, { id }) => {
    res.json(store.undelete(id, "user"));
  });

  route("POST", "pages/:id/purge", async (req, res, { id }) => {
    const b = await body<{ confirm: string }>(req);
    res.json({ unlinked: store.purge(id, b.confirm, "user") });
  });
}
