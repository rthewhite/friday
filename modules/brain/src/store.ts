/**
 * The brain store (design D2). Every mutation runs in one `ctx.db` transaction and ends in
 * `writeRevision`, which checks the base revision, validates the fields, applies the tombstone
 * guard, replaces the page's names and records the full snapshot. `brain-nightly` adds its
 * authors on this same path, so its guards come from here too.
 */
import { randomUUID } from "node:crypto";
import type { ModuleDb } from "@friday/sdk";
import { nameKey, parseLinks, unlink } from "./links.js";
import { PROFILE_ID } from "./schema.js";
import { PAGE_TYPES, type PageType } from "./types.js";

export { PAGE_TYPES, type PageType };

export const AUTHORS = ["system", "user", "remember", "extraction", "consolidation"] as const;
export type Author = (typeof AUTHORS)[number];

export const NAME_MAX = 80;
export const ALIASES_MAX = 20;
export const BODY_MAX = 20000;
export const FACT_MAX = 500;

export type BrainErrorCode = "invalid" | "stale" | "name_taken" | "tombstoned" | "not_found" | "profile" | "not_deleted" | "not_empty";

export class BrainError extends Error {
  constructor(
    readonly code: BrainErrorCode,
    message: string,
    /** `stale`: the page as it is now. */
    readonly current?: Page,
    /** `name_taken` / `tombstoned`: the names involved. */
    readonly names?: string[],
  ) {
    super(message);
    this.name = "BrainError";
  }
}

export interface PageFields {
  name: string;
  type: PageType;
  aliases: string[];
  body: string;
}

export interface Page extends PageFields {
  id: string;
  isProfile: boolean;
  revisionId: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface Revision extends PageFields {
  id: number;
  pageId: string;
  author: Author;
  baseRevisionId?: number;
  sources: string[];
  note?: string;
  createdAt: string;
}

export type RevisionSummary = Pick<Revision, "id" | "author" | "createdAt" | "note" | "sources">;

export interface WriteOptions {
  /** The revision the writer based its change on; refused as `stale` when it is no longer current. */
  base?: number;
  /** Source conversation ids, when known. */
  sources?: string[];
  note?: string;
  /** On a rename, add the old name as an alias (default true). */
  keepOldName?: boolean;
}

export interface OutgoingLink {
  target: string;
  line: string;
  /** Set when the target resolves to a live page; otherwise the link is dangling. */
  pageId?: string;
  pageName?: string;
}

export interface Backlink {
  pageId: string;
  name: string;
  line: string;
}

export type RememberResult =
  | { stored: true; page: string; created: boolean }
  | { stored: false; reason: "already_known" | "tombstoned" | "invalid"; page?: string; message: string };

interface PageRow {
  id: string;
  name: string;
  type: string;
  aliases_json: string;
  body: string;
  is_profile: number;
  revision_id: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface RevisionRow {
  id: number;
  page_id: string;
  author: string;
  base_revision_id: number | null;
  name: string;
  type: string;
  aliases_json: string;
  body: string;
  sources_json: string;
  note: string | null;
  created_at: string;
}

const toPage = (r: PageRow): Page => ({
  id: r.id,
  name: r.name,
  type: r.type as PageType,
  aliases: JSON.parse(r.aliases_json) as string[],
  body: r.body,
  isProfile: r.is_profile === 1,
  revisionId: r.revision_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.deleted_at ? { deletedAt: r.deleted_at } : {}),
});

const toRevision = (r: RevisionRow): Revision => ({
  id: r.id,
  pageId: r.page_id,
  author: r.author as Author,
  ...(r.base_revision_id !== null ? { baseRevisionId: r.base_revision_id } : {}),
  name: r.name,
  type: r.type as PageType,
  aliases: JSON.parse(r.aliases_json) as string[],
  body: r.body,
  sources: JSON.parse(r.sources_json) as string[],
  ...(r.note !== null ? { note: r.note } : {}),
  createdAt: r.created_at,
});

/** A name as stored: NFC, trimmed, inner whitespace collapsed (case kept). */
const cleanName = (s: string): string => s.normalize("NFC").trim().replace(/\s+/g, " ");

function validName(raw: unknown, what: string, isProfile: boolean): string {
  if (typeof raw !== "string") throw new BrainError("invalid", `${what} must be text`);
  if (/[\r\n]/.test(raw)) throw new BrainError("invalid", `${what} may not contain a line break`);
  const name = cleanName(raw);
  if (!name || name.length > NAME_MAX) throw new BrainError("invalid", `${what} must be 1 to ${NAME_MAX} characters`);
  if (name.includes("[[") || name.includes("]]")) throw new BrainError("invalid", `${what} may not contain [[ or ]]`);
  if (!isProfile && nameKey(name) === "profile") throw new BrainError("invalid", `"profile" is reserved for the profile page`);
  return name;
}

/** Checks and normalizes a page's fields: name and alias rules, at most 20 aliases, body size, type enum. */
export function validateFields(fields: Partial<PageFields>, isProfile = false): PageFields {
  const name = validName(fields.name, "name", isProfile);
  const type = fields.type ?? "other";
  if (!PAGE_TYPES.includes(type as PageType)) throw new BrainError("invalid", `type must be one of ${PAGE_TYPES.join(", ")}`);
  const rawAliases = fields.aliases ?? [];
  if (!Array.isArray(rawAliases)) throw new BrainError("invalid", "aliases must be a list");
  const seen = new Set([nameKey(name)]);
  const aliases: string[] = [];
  for (const a of rawAliases) {
    const alias = validName(a, "alias", false);
    const key = nameKey(alias);
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  if (aliases.length > ALIASES_MAX) throw new BrainError("invalid", `a page may have at most ${ALIASES_MAX} aliases`);
  const body = fields.body ?? "";
  if (typeof body !== "string") throw new BrainError("invalid", "body must be text");
  if (body.length > BODY_MAX) throw new BrainError("invalid", `body may be at most ${BODY_MAX} characters`);
  return { name, type: type as PageType, aliases, body };
}

const keysOf = (p: Pick<PageFields, "name" | "aliases">): string[] => [nameKey(p.name), ...p.aliases.map(nameKey)];

export interface BrainStoreOptions {
  now?: () => Date;
  newId?: () => string;
}

export class BrainStore {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly db: ModuleDb, opts: BrainStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? randomUUID;
  }

  // ---- reads ----

  get(id: string): Page | undefined {
    const row = this.db.prepare("SELECT * FROM brain__pages WHERE id = ?").get(id) as PageRow | undefined;
    return row && toPage(row);
  }

  profile(): Page {
    return this.get(PROFILE_ID)!;
  }

  /** Live pages, most recently updated first (the profile included). */
  list(): Page[] {
    return (this.db.prepare("SELECT * FROM brain__pages WHERE deleted_at IS NULL ORDER BY updated_at DESC, id").all() as unknown as PageRow[]).map(toPage);
  }

  /** Live pages other than the profile, most recently updated first, at most `limit`. */
  recent(limit: number): Page[] {
    return (this.db.prepare("SELECT * FROM brain__pages WHERE deleted_at IS NULL AND is_profile = 0 ORDER BY updated_at DESC, id LIMIT ?").all(limit) as unknown as PageRow[]).map(toPage);
  }

  /** Number of live pages other than the profile. */
  count(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM brain__pages WHERE deleted_at IS NULL AND is_profile = 0").get() as { n: number }).n;
  }

  /** Soft-deleted pages, most recently deleted first. */
  deleted(): Page[] {
    return (this.db.prepare("SELECT * FROM brain__pages WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id").all() as unknown as PageRow[]).map(toPage);
  }

  /** The live page whose name or alias matches `name`. */
  resolve(name: string): Page | undefined {
    const row = this.db.prepare("SELECT p.* FROM brain__names n JOIN brain__pages p ON p.id = n.page_id WHERE n.key = ?").get(nameKey(name)) as PageRow | undefined;
    return row && toPage(row);
  }

  revisions(pageId: string): RevisionSummary[] {
    const rows = this.db.prepare("SELECT id, author, created_at, note, sources_json FROM brain__revisions WHERE page_id = ? ORDER BY id DESC").all(pageId) as unknown as RevisionRow[];
    return rows.map((r) => ({ id: r.id, author: r.author as Author, createdAt: r.created_at, ...(r.note !== null ? { note: r.note } : {}), sources: JSON.parse(r.sources_json) as string[] }));
  }

  revision(pageId: string, revisionId: number): Revision | undefined {
    const row = this.db.prepare("SELECT * FROM brain__revisions WHERE page_id = ? AND id = ?").get(pageId, revisionId) as RevisionRow | undefined;
    return row && toRevision(row);
  }

  /** Names of purged pages, which only the user may bring back. */
  tombstones(): { key: string; name: string }[] {
    return (this.db.prepare("SELECT key, name FROM brain__tombstones ORDER BY name").all() as unknown as { key: string; name: string }[]).map((r) => ({ ...r }));
  }

  /** `[[link]]` targets on live pages that no live page answers to, deduplicated by name key. */
  danglingTargets(): string[] {
    const out = new Map<string, string>();
    for (const p of this.list()) for (const l of this.links(p)) if (!l.pageId && !out.has(nameKey(l.target))) out.set(nameKey(l.target), l.target);
    return [...out.values()];
  }

  /**
   * Live pages with a revision newer than `revisionId` written by someone other than the `excluded`
   * authors, mapped to the first such revision. Reverts of a nightly run don't count: consolidating
   * the page again would redo what the user just undid.
   */
  changesSince(revisionId: number, excluded: Author[] = ["consolidation", "system"]): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT r.page_id AS id, min(r.id) AS first FROM brain__revisions r JOIN brain__pages p ON p.id = r.page_id
        WHERE r.id > ? AND p.deleted_at IS NULL AND r.author NOT IN (${excluded.map(() => "?").join(", ") || "''"})
          AND (r.note IS NULL OR r.note NOT LIKE 'reverted nightly run %')
        GROUP BY r.page_id`)
      .all(revisionId, ...excluded) as { id: string; first: number }[];
    return new Map(rows.map((r) => [r.id, r.first]));
  }

  /** Ids of the pages `changesSince` reports. */
  changedSince(revisionId: number, excluded: Author[] = ["consolidation", "system"]): string[] {
    return [...this.changesSince(revisionId, excluded).keys()];
  }

  /** A page's `[[links]]`, resolved through live names and aliases. */
  links(page: Pick<Page, "body">): OutgoingLink[] {
    return parseLinks(page.body).map(({ target, line }) => {
      const to = this.resolve(target);
      return to ? { target, line, pageId: to.id, pageName: to.name } : { target, line };
    });
  }

  /** Live pages that link to `page` by its name or one of its aliases, with the linking line. */
  backlinks(page: Pick<Page, "id" | "name" | "aliases">): Backlink[] {
    const keys = new Set(keysOf(page));
    const out: Backlink[] = [];
    for (const other of this.list()) {
      if (other.id === page.id) continue;
      for (const l of parseLinks(other.body)) if (keys.has(nameKey(l.target))) out.push({ pageId: other.id, name: other.name, line: l.line });
    }
    return out;
  }

  // ---- writes ----

  create(fields: Partial<PageFields>, author: Author, opts: WriteOptions = {}): Page {
    return this.db.transaction(() => {
      const id = this.newId();
      const at = this.now().toISOString();
      // Placeholder row so the revision and names can reference it; writeRevision fills it in.
      this.db.prepare("INSERT INTO brain__pages (id, name, type, created_at, updated_at) VALUES (?, '', 'other', ?, ?)").run(id, at, at);
      return this.writeRevision({ id, name: "", type: "other", aliases: [], body: "", isProfile: false, revisionId: 0, createdAt: at, updatedAt: at }, author, fields, { ...opts, base: undefined, keepOldName: false });
    });
  }

  save(id: string, fields: Partial<PageFields>, author: Author, opts: WriteOptions = {}): Page {
    return this.db.transaction(() => this.writeRevision(this.live(id), author, fields, opts));
  }

  /** Makes a revision's content current again, as a new revision noting which one was restored. */
  restore(id: string, revisionId: number, author: Author, base?: number, note = `restored revision ${revisionId}`): Page {
    return this.db.transaction(() => {
      const page = this.live(id);
      const rev = this.revision(id, revisionId);
      if (!rev) throw new BrainError("not_found", `revision ${revisionId} of this page does not exist`);
      return this.writeRevision(page, author, rev, { base, note, keepOldName: false });
    });
  }

  softDelete(id: string, author: Author, opts: { base?: number; note?: string } = {}): Page {
    return this.db.transaction(() => {
      const page = this.live(id);
      if (page.isProfile) throw new BrainError("profile", "the profile cannot be deleted");
      if (opts.base !== undefined && opts.base !== page.revisionId) throw new BrainError("stale", "the page changed since it was opened", page);
      const at = this.now().toISOString();
      this.db.prepare("UPDATE brain__pages SET deleted_at = ? WHERE id = ?").run(at, id);
      return this.writeRevision({ ...page, deletedAt: at }, author, page, { note: opts.note ?? "deleted" });
    });
  }

  /**
   * Import only (`import.ts`): gives a freshly created page the times it had in Jarvis, and marks it
   * deleted there when it was (freeing its names, as a soft delete does, without another revision).
   */
  setImportedTimes(id: string, t: { createdAt: string; updatedAt: string; deletedAt?: string }): void {
    this.db.prepare("UPDATE brain__pages SET created_at = ?, updated_at = ?, deleted_at = ? WHERE id = ?").run(t.createdAt, t.updatedAt, t.deletedAt ?? null, id);
    if (t.deletedAt) this.db.prepare("DELETE FROM brain__names WHERE page_id = ?").run(id);
  }

  /** Import only (`import.ts`): tombstones a name that was purged in Jarvis. */
  addTombstone(name: string, purgedAt: string): void {
    this.db.prepare("INSERT INTO brain__tombstones (key, name, purged_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING").run(nameKey(name), cleanName(name), purgedAt);
  }

  /** The id of the newest revision in the brain (0 when there is none). */
  lastRevisionId(): number {
    const seq = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'brain__revisions'").get() as { seq: number } | undefined;
    const max = (this.db.prepare("SELECT max(id) AS m FROM brain__revisions").get() as { m: number | null }).m ?? 0;
    return Math.max(seq?.seq ?? 0, max);
  }

  undelete(id: string, author: Author): Page {
    return this.db.transaction(() => {
      const page = this.get(id);
      if (!page) throw new BrainError("not_found", "no such page");
      if (!page.deletedAt) return page;
      this.db.prepare("UPDATE brain__pages SET deleted_at = NULL WHERE id = ?").run(id);
      const { deletedAt: _, ...live } = page;
      return this.writeRevision(live, author, page, { note: "undeleted" });
    });
  }

  /**
   * Forgets a soft-deleted page: tombstones its names (except ones now used by live pages), rewrites
   * inbound `[[links]]` in live pages as plain text, and deletes the page with its revisions.
   * Returns the names of the pages whose links were rewritten.
   */
  purge(id: string, confirm: unknown, author: Author): string[] {
    return this.db.transaction(() => {
      const page = this.get(id);
      if (!page) throw new BrainError("not_found", "no such page");
      if (!page.deletedAt) throw new BrainError("not_deleted", "only a deleted page can be purged; delete it first");
      if (confirm !== page.name) throw new BrainError("invalid", `type the page's name (${page.name}) to confirm`);
      const at = this.now().toISOString();
      const forgotten = new Set<string>();
      for (const name of [page.name, ...page.aliases]) {
        const key = nameKey(name);
        if (forgotten.has(key) || this.owner(key)) continue;
        forgotten.add(key);
        this.db.prepare("INSERT INTO brain__tombstones (key, name, purged_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET name = excluded.name, purged_at = excluded.purged_at").run(key, name, at);
      }
      const unlinked: string[] = [];
      for (const other of this.list()) {
        const body = unlink(other.body, forgotten);
        if (body === other.body) continue;
        this.writeRevision(other, author, { ...other, body }, { note: `unlinked "${page.name}" after purge`, keepOldName: false });
        unlinked.push(other.name);
      }
      this.db.prepare("DELETE FROM brain__pages WHERE id = ?").run(id);
      return unlinked;
    });
  }

  /**
   * `brain_remember` (design D3): appends `- <date>: <fact>` under the page's `## Notes`, creating the
   * page when nothing matches `entity` (`profile` resolves through its name). Never changes existing text.
   * A fact that repeats the latest note, or a note of the same day, is skipped; anything else is a new
   * note, so a correction back to an older fact is kept as the newest one.
   */
  appendNote(entity: string, fact: string, type: PageType | undefined, date: string, opts: { author?: "remember" | "extraction"; sources?: string[] } = {}): RememberResult {
    const author = opts.author ?? "remember";
    const sources = opts.sources ?? [];
    const clean = typeof fact === "string" ? fact.replace(/\s+/g, " ").trim() : "";
    if (!clean) return { stored: false, reason: "invalid", message: "the fact is empty" };
    if (clean.length > FACT_MAX) return { stored: false, reason: "invalid", message: `a fact may be at most ${FACT_MAX} characters; store one short fact per call` };
    if (type !== undefined && !PAGE_TYPES.includes(type)) return { stored: false, reason: "invalid", message: `type must be one of ${PAGE_TYPES.join(", ")}` };
    const note = `- ${date}: ${clean}`;
    try {
      return this.db.transaction((): RememberResult => {
        const target = this.resolve(String(entity ?? ""));
        if (!target) {
          const page = this.create({ name: String(entity ?? ""), type: type ?? "other", aliases: [], body: `## Notes\n${note}` }, author, { sources });
          return { stored: true, page: page.name, created: true };
        }
        if (alreadyNoted(target.body, clean, date)) {
          return { stored: false, reason: "already_known", page: target.name, message: `${target.name} already has this fact` };
        }
        this.writeRevision(target, author, { ...target, body: appendUnderNotes(target.body, note) }, { keepOldName: false, sources });
        return { stored: true, page: target.name, created: false };
      });
    } catch (e) {
      if (e instanceof BrainError && e.code === "tombstoned") {
        return { stored: false, reason: "tombstoned", message: "this was deliberately forgotten; the user can recreate it in the portal" };
      }
      if (e instanceof BrainError && e.code === "invalid") return { stored: false, reason: "invalid", message: e.message };
      throw e;
    }
  }

  /** The single write path. Must run inside a transaction. */
  private writeRevision(page: Page, author: Author, input: Partial<PageFields>, opts: WriteOptions = {}): Page {
    if (!AUTHORS.includes(author)) throw new BrainError("invalid", `unknown author ${JSON.stringify(author)}`);
    if (opts.base !== undefined && opts.base !== page.revisionId) {
      throw new BrainError("stale", "the page changed since it was opened", this.get(page.id));
    }
    const fields = validateFields(input, page.isProfile);
    if (page.isProfile && (fields.name !== page.name || fields.type !== page.type)) {
      throw new BrainError("profile", "the profile's name and type cannot change");
    }
    const renamed = page.name !== "" && nameKey(fields.name) !== nameKey(page.name);
    if (renamed && opts.keepOldName !== false && !fields.aliases.some((a) => nameKey(a) === nameKey(page.name))) {
      if (fields.aliases.length >= ALIASES_MAX) {
        throw new BrainError("invalid", `renaming keeps "${page.name}" as an alias, but the page already has ${ALIASES_MAX}; remove an alias or don't keep the old name`);
      }
      fields.aliases = [...fields.aliases, page.name];
    }
    const keys = keysOf(fields);

    const tombstoned = keys.flatMap((k) => {
      const t = this.db.prepare("SELECT name FROM brain__tombstones WHERE key = ?").get(k) as { name: string } | undefined;
      return t ? [t.name] : [];
    });
    if (tombstoned.length) {
      if (author !== "user") throw new BrainError("tombstoned", `${tombstoned.join(", ")} was deliberately forgotten`, undefined, tombstoned);
      for (const k of keys) this.db.prepare("DELETE FROM brain__tombstones WHERE key = ?").run(k);
    }

    this.db.prepare("DELETE FROM brain__names WHERE page_id = ?").run(page.id);
    if (!page.deletedAt) {
      const taken = [fields.name, ...fields.aliases].filter((n) => this.owner(nameKey(n)));
      if (taken.length) throw new BrainError("name_taken", `already used by another page: ${taken.join(", ")}`, undefined, taken);
      const insert = this.db.prepare("INSERT INTO brain__names (key, page_id, kind) VALUES (?, ?, ?)");
      insert.run(nameKey(fields.name), page.id, "name");
      for (const a of fields.aliases) insert.run(nameKey(a), page.id, "alias");
    }

    const at = this.now().toISOString();
    const rev = Number(this.db
      .prepare("INSERT INTO brain__revisions (page_id, author, base_revision_id, name, type, aliases_json, body, sources_json, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(page.id, author, page.revisionId || null, fields.name, fields.type, JSON.stringify(fields.aliases), fields.body, JSON.stringify(opts.sources ?? []), opts.note ?? null, at).lastInsertRowid);
    this.db
      .prepare("UPDATE brain__pages SET name = ?, type = ?, aliases_json = ?, body = ?, revision_id = ?, updated_at = ? WHERE id = ?")
      .run(fields.name, fields.type, JSON.stringify(fields.aliases), fields.body, rev, at, page.id);
    return this.get(page.id)!;
  }

  /** A live, existing page, or `not_found`. */
  private live(id: string): Page {
    const page = this.get(id);
    if (!page || page.deletedAt) throw new BrainError("not_found", page ? "the page is deleted" : "no such page");
    return page;
  }

  /** The live page that owns a name key, if any. */
  private owner(key: string): string | undefined {
    return (this.db.prepare("SELECT page_id FROM brain__names WHERE key = ?").get(key) as { page_id: string } | undefined)?.page_id;
  }
}

/** A dated note line: `- 2026-09-29: text`. */
const NOTE_LINE = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2}):\s*(.*?)\s*$/;

/**
 * Whether `fact` repeats the page's latest dated note, or a note dated `date` (the same day), compared
 * case-insensitively. Older notes don't count: remembering an earlier fact again is a correction.
 */
export function alreadyNoted(body: string, fact: string, date: string): boolean {
  const same = (text: string) => text.replace(/\s+/g, " ").toLowerCase() === fact.toLowerCase();
  const notes = body.split("\n").flatMap((l) => {
    const m = NOTE_LINE.exec(l);
    return m ? [{ date: m[1]!, text: m[2]! }] : [];
  });
  const latest = notes.at(-1);
  return (latest !== undefined && same(latest.text)) || notes.some((n) => n.date === date && same(n.text));
}

/** `note` as the last line of the last `## Notes` section, adding the section at the end when there is none. */
export function appendUnderNotes(body: string, note: string): string {
  const lines = body.split("\n");
  let heading = -1;
  lines.forEach((l, i) => { if (/^##\s+Notes\s*$/i.test(l.trim())) heading = i; });
  if (heading === -1) {
    const base = body.trimEnd();
    return `${base}${base ? "\n\n" : ""}## Notes\n${note}`;
  }
  // The section runs until the next heading of level 1 or 2.
  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i]!.trim())) { end = i; break; }
  let last = heading;
  for (let i = heading + 1; i < end; i++) if (lines[i]!.trim()) last = i;
  lines.splice(last + 1, 0, note);
  return lines.join("\n");
}
