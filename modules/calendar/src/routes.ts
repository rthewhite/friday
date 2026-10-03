/** HTTP routes under /api/modules/calendar/ for the portal page. None of them ever returns the password. */
import type { HttpMethod, ModuleContext, RouteRequest, RouteResponse } from "@friday/sdk";
import type { Agenda } from "./agenda.js";
import type { Change, ChangeLog } from "./changes.js";
import { CredentialRejectedError, InputError, NotUndoableError, StaleEventError, UpstreamError } from "./errors.js";
import type { CalendarService } from "./service.js";
import type { Settings } from "./settings.js";

export const DEFAULT_CHANGES = 50;
export const MAX_CHANGES_PAGE = 200;

export interface RouteDeps {
  service: CalendarService;
  settings: Settings;
  agenda: Agenda;
  changes: ChangeLog;
  /** Starts the refresh job (after settings change). */
  refresh: () => void;
}

type Handler = (req: RouteRequest, res: RouteResponse, params: Record<string, string>) => Promise<void> | void;

/** Known errors become JSON with a status; anything else is core's 500. */
const handle = (fn: Handler): Handler => async (req, res, params) => {
  try {
    await fn(req, res, params);
  } catch (e) {
    if (e instanceof InputError) res.status(400).json({ error: e.message });
    else if (e instanceof NotUndoableError) res.status(409).json({ error: e.message });
    else if (e instanceof StaleEventError) res.status(409).json({ error: e.message, current: e.current ?? null });
    else if (e instanceof CredentialRejectedError || e instanceof UpstreamError) res.status(502).json({ error: e.message });
    else throw e;
  }
};

async function body(req: RouteRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new InputError("the body must be JSON");
  }
}

export function changeView(c: Change) {
  return {
    id: c.id,
    at: c.at,
    source: c.source,
    ...(c.conversationId ? { conversationId: c.conversationId } : {}),
    action: c.action,
    ...(c.scope ? { scope: c.scope } : {}),
    title: c.title,
    before: c.beforeSummary,
    after: c.afterSummary,
    ...(c.undoOf !== undefined ? { undoOf: c.undoOf } : {}),
    undone: c.undoneBy !== undefined,
    undoable: c.action !== "undo" && c.undoneBy === undefined,
  };
}

export function registerCalendarRoutes(ctx: ModuleContext, d: RouteDeps): void {
  const route = (method: HttpMethod, path: string, fn: Handler) => ctx.http.route(method, path, handle(fn));

  const status = async () => {
    // Discover once if nothing has been fetched yet, so the page shows calendars right after setup.
    if (!d.service.lastAccount) await d.service.account().catch(() => undefined);
    const account = d.service.lastAccount;
    const def = account ? d.settings.defaultCalendar(account.calendars) : undefined;
    return {
      username: ctx.config.get("ICLOUD_USERNAME") ?? null,
      connected: d.service.status.ok,
      checkedAt: d.service.status.checkedAt ?? null,
      error: d.service.status.error ?? null,
      calendars: (account?.calendars ?? []).map((c) => ({ id: c.id, name: c.name, color: c.color ?? null, writable: c.writable, ...d.settings.of(c.id), default: c.id === def?.id })),
    };
  };

  route("GET", "status", async (_req, res) => {
    res.json(await status());
  });

  route("PUT", "settings", async (req, res) => {
    const account = await d.service.account();
    await d.settings.update(await body(req), account.calendars);
    d.refresh();
    res.json(await status());
  });

  route("GET", "agenda", (_req, res) => {
    res.json({ text: d.agenda.render(), fetchedAt: d.agenda.fetchedAt?.toISOString() ?? null });
  });

  route("GET", "changes", (req, res) => {
    const raw = req.query.get("limit");
    const limit = raw === null ? DEFAULT_CHANGES : Number(raw);
    if (!Number.isInteger(limit) || limit < 1) throw new InputError("limit must be a positive whole number");
    res.json({ changes: d.changes.list(Math.min(limit, MAX_CHANGES_PAGE)).map(changeView) });
  });

  route("POST", "changes/:id/undo", async (_req, res, params) => {
    const id = Number(params.id);
    const change = Number.isInteger(id) ? d.changes.get(id) : undefined;
    if (!change) {
      res.status(404).json({ error: "no such change" });
      return;
    }
    const { undo, say } = await d.service.undo(change, "portal");
    res.json({ say, undo: changeView(undo), change: changeView(d.changes.get(id)!) });
  });

  route("POST", "refresh", async (_req, res) => {
    // A failure shows up in the status it answers with.
    await d.agenda.refresh().catch(() => undefined);
    res.json(await status());
  });
}
