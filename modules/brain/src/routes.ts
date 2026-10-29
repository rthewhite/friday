/**
 * HTTP routes under /api/modules/brain/ (design D7). The portal is the only place memories are deleted. Every route
 * works on the requesting user's own brain, admins included (user-privacy).
 */
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

/** The brain a portal request works on: the requesting user's own. Another user's page is a 404 there. */
export type RequestBrain = (req: RouteRequest) => BrainStore;

/** `pages/profile` names the caller's own profile, whatever its id. */
export const PROFILE_ALIAS = "profile";

/** The brain of the request's user; core always sets one, so a request without one is refused. */
export const requestBrain = (forUser: (user: { id: string; name: string }) => BrainStore): RequestBrain => (req) => {
  if (!req.user) throw new BrainError("not_found", "the brain needs a logged-in user");
  return forUser(req.user);
};

export function registerBrainRoutes(ctx: ModuleContext, brainOf: RequestBrain, budget: () => number): void {
  type BrainHandler = (store: BrainStore, req: RouteRequest, res: RouteResponse, params: Record<string, string>) => void | Promise<void>;
  const route = (method: Parameters<ModuleContext["http"]["route"]>[0], path: string, fn: BrainHandler) =>
    ctx.http.route(method, path, handle((req, res, params) => fn(brainOf(req), req, res, params)));
  // Portal writes record who made them; the store is synchronous, so the user is set around each call only.
  const as = <T>(store: BrainStore, req: RouteRequest, fn: () => T): T => store.asUser(req.user, fn);
  const pageId = (store: BrainStore, id: string) => (id === PROFILE_ALIAS ? store.profileId() : id);
  const found = (store: BrainStore, id: string): Page => {
    const p = store.get(id);
    if (!p) throw new BrainError("not_found", "no such page");
    return p;
  };

  route("GET", "pages", (store, _req, res) => {
    const profile = store.profile();
    const used = estimateTokens(profile.body);
    const budgetTokens = budget();
    res.json({
      profile: { id: profile.id, usedTokens: used, budgetTokens, overBudget: used > budgetTokens, instructions: profile.instructions ?? "", subjectId: profile.subjectId },
      pages: store.list().map(summary),
      deleted: store.deleted().map((p) => ({ id: p.id, name: p.name, deletedAt: p.deletedAt })),
    });
  });

  route("GET", "pages/:id", (store, _req, res, params) => {
    const id = pageId(store, params.id);
    const page = found(store, id);
    res.json({ ...page, isSubject: page.id === store.subjectId(), revisions: store.revisions(id), links: store.links(page), backlinks: page.deletedAt ? [] : store.backlinks(page) });
  });

  route("GET", "pages/:id/revisions/:rev", (store, _req, res, params) => {
    const id = pageId(store, params.id);
    found(store, id);
    const r = store.revision(id, revisionNumber(params.rev, "rev"));
    if (!r) throw new BrainError("not_found", "no such revision");
    res.json(r);
  });

  route("POST", "pages", async (store, req, res) => {
    const b = await body<PageFields>(req);
    res.status(201).json(as(store, req, () => store.create({ name: b.name, type: b.type, aliases: b.aliases, body: b.body }, "user")));
  });

  route("PUT", "pages/:id", async (store, req, res, params) => {
    const id = pageId(store, params.id);
    const b = await body<PageFields & { baseRevision: number; keepOldName: boolean; instructions: string }>(req);
    const base = revisionNumber(b.baseRevision, "baseRevision");
    if (id === store.profileId()) {
      // The profile takes only its instructions; the summary is generated (hybrid-profile D8).
      const p = store.profile();
      const changed = (["name", "type", "body"] as const).some((k) => b[k] !== undefined && b[k] !== p[k]) || (b.aliases !== undefined && JSON.stringify(b.aliases) !== JSON.stringify(p.aliases));
      if (changed) throw new BrainError("profile", "only the profile's instructions can be edited; its summary is generated from the pages");
      res.json(as(store, req, () => store.saveInstructions(b.instructions, base)));
      return;
    }
    res.json(as(store, req, () => store.save(id, { name: b.name, type: b.type, aliases: b.aliases, body: b.body }, "user", { base, keepOldName: b.keepOldName !== false })));
  });

  route("POST", "pages/:id/restore", async (store, req, res, params) => {
    const id = pageId(store, params.id);
    const b = await body<{ revisionId: number; baseRevision: number }>(req);
    const revisionId = revisionNumber(b.revisionId, "revisionId");
    const base = revisionNumber(b.baseRevision, "baseRevision");
    // On the profile only the instructions come back; the summary stays as generated.
    res.json(as(store, req, () => (id === store.profileId() ? store.restoreInstructions(revisionId, base) : store.restore(id, revisionId, "user", base))));
  });

  route("DELETE", "pages/:id", (store, req, res, params) => {
    as(store, req, () => store.softDelete(pageId(store, params.id), "user"));
    res.status(204);
  });

  route("POST", "pages/:id/undelete", (store, req, res, params) => {
    res.json(as(store, req, () => store.undelete(pageId(store, params.id), "user")));
  });

  route("POST", "pages/:id/purge", async (store, req, res, params) => {
    const b = await body<{ confirm: string }>(req);
    res.json({ unlinked: as(store, req, () => store.purge(pageId(store, params.id), b.confirm, "user")) });
  });
}
