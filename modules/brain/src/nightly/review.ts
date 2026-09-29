/**
 * Reviewing and reverting nightly runs (design D6): what each run changed per page, with the dropped lines,
 * merges and source conversations, and a per-page revert. Routes under /api/modules/brain/runs.
 */
import type { ModuleContext, ModuleConversations, ModuleDb } from "@friday/sdk";
import { body, handle, revisionNumber, type Handler } from "../routes.js";
import { BrainError, type BrainStore, type Revision } from "../store.js";
import type { DroppedLine, Run, RunStore } from "./runs.js";

export interface RunPage {
  pageId: string;
  name: string;
  /** The page is soft-deleted now (merged away, or deleted since). */
  deleted: boolean;
  /** The page's last revision before the run; absent when the run created the page. */
  before?: Revision;
  /** The run's last revision of the page. */
  after: Revision;
  authors: string[];
  sources: { id: string; exists: boolean }[];
  dropped: DroppedLine[];
  /** Set on a page the run merged into another. */
  mergedInto?: string;
  /** Set on a merge target: the page it absorbed. */
  mergedFrom?: string;
  currentRevisionId: number;
  /** The page changed after the run (or someone else wrote it during the run), so a revert would be refused as stale. */
  changedSince: boolean;
}

interface RunRevisionRow {
  id: number;
  page_id: string;
  author: string;
  sources_json: string;
}

/** The pages a run touched, from its revisions (authors extraction and consolidation) in its id range. */
export async function runPages(db: ModuleDb, store: BrainStore, conversations: ModuleConversations, run: Run): Promise<RunPage[]> {
  const last = run.lastRevisionId ?? store.lastRevisionId();
  const rows = db
    .prepare("SELECT id, page_id, author, sources_json FROM brain__revisions WHERE id BETWEEN ? AND ? AND author IN ('extraction', 'consolidation') ORDER BY id")
    .all(run.firstRevisionId, last) as unknown as RunRevisionRow[];
  const byPage = new Map<string, RunRevisionRow[]>();
  for (const r of rows) byPage.set(r.page_id, [...(byPage.get(r.page_id) ?? []), r]);
  const exists = new Map<string, boolean>();
  const out: RunPage[] = [];
  for (const [pageId, revs] of byPage) {
    const page = store.get(pageId);
    if (!page) continue; // purged since
    const prior = db.prepare("SELECT id FROM brain__revisions WHERE page_id = ? AND id < ? ORDER BY id DESC LIMIT 1").get(pageId, run.firstRevisionId) as { id: number } | undefined;
    const after = store.revision(pageId, revs[revs.length - 1]!.id)!;
    const sourceIds = [...new Set(revs.flatMap((r) => JSON.parse(r.sources_json) as string[]))];
    for (const id of sourceIds) if (!exists.has(id)) exists.set(id, (await conversations.get(id)) !== undefined);
    const into = run.mergeRecords.find((m) => m.from === pageId)?.into;
    const from = run.mergeRecords.find((m) => m.into === pageId)?.from;
    // Someone else (the user, brain_remember) wrote this page while the run was going: restoring the
    // pre-run revision would silently undo that, so the page counts as changed since the run.
    const interleaved = (db
      .prepare("SELECT count(*) AS n FROM brain__revisions WHERE page_id = ? AND id BETWEEN ? AND ? AND author NOT IN ('extraction', 'consolidation')")
      .get(pageId, run.firstRevisionId, after.id) as { n: number }).n > 0;
    out.push({
      pageId,
      name: page.name,
      deleted: !!page.deletedAt,
      ...(prior ? { before: store.revision(pageId, prior.id)! } : {}),
      after,
      authors: [...new Set(revs.map((r) => r.author))],
      sources: sourceIds.map((id) => ({ id, exists: exists.get(id)! })),
      dropped: run.dropped.filter((d) => d.pageId === pageId),
      ...(into ? { mergedInto: into } : {}),
      ...(from ? { mergedFrom: from } : {}),
      currentRevisionId: page.revisionId,
      changedSince: page.revisionId !== after.id || interleaved,
    });
  }
  return out;
}

/**
 * Undoes what a run did to one page, as the user, in one transaction: restores the pre-run revision, or
 * deletes a page the run created; reverting a merge (from either side) also brings the absorbed page back.
 * Refused as `stale` when the page changed after the run or since `base`. Returns the pages reverted.
 */
export function revertPage(db: ModuleDb, store: BrainStore, run: Run, pages: RunPage[], pageId: string, base: number): string[] {
  let target = pages.find((p) => p.pageId === pageId);
  if (!target) throw new BrainError("not_found", "this run didn't change that page");
  if (target.mergedInto) target = pages.find((p) => p.pageId === target!.mergedInto) ?? target;
  const t = target;
  const current = store.get(t.pageId)!;
  if (t.changedSince || (pageId === t.pageId && base !== current.revisionId)) {
    throw new BrainError("stale", `${current.name} changed after the run; open the page to restore an older version by hand`, current);
  }
  const note = `reverted nightly run ${run.id}`;
  return db.transaction(() => {
    const done: string[] = [];
    if (!t.before) {
      store.softDelete(t.pageId, "user", { note });
    } else {
      store.restore(t.pageId, t.before.id, "user", current.revisionId, note);
    }
    done.push(current.name);
    if (t.mergedFrom) {
      // The restore freed the absorbed page's names, so it can come back as it was.
      const from = store.undelete(t.mergedFrom, "user");
      done.push(from.name);
    }
    return done;
  });
}

export function registerRunRoutes(ctx: ModuleContext, store: BrainStore, runs: RunStore): void {
  const route = (method: "GET" | "POST", path: string, fn: Handler) => ctx.http.route(method, path, handle(fn));
  const found = (id: string): Run => {
    const run = runs.get(revisionNumber(id, "run id"));
    if (!run) throw new BrainError("not_found", "no such run");
    return run;
  };

  route("GET", "runs", (req, res) => {
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.get("limit") ?? 14)) || 14));
    res.json({ runs: runs.list(limit) });
  });

  route("GET", "runs/:id", async (_req, res, { id }) => {
    const run = found(id);
    res.json({ run, pages: await runPages(ctx.db, store, ctx.conversations, run) });
  });

  route("POST", "runs/:id/pages/:pageId/revert", async (req, res, { id, pageId }) => {
    const run = found(id);
    const b = await body<{ base: number }>(req);
    const base = revisionNumber(b.base, "base");
    const pages = await runPages(ctx.db, store, ctx.conversations, run);
    res.json({ reverted: revertPage(ctx.db, store, run, pages, pageId, base) });
  });
}
