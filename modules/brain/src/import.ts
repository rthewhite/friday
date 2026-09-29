/**
 * One-off import of a Jarvis user's brain into an empty brain (change brain-import, design D2/D3).
 * Everything goes through the store's validation; the whole import is one transaction, and a dry
 * run reports what would happen without writing anything.
 */
import type { ModuleDb } from "@friday/sdk";
import { isLinkTarget, nameKey } from "./links.js";
import { BrainError, validateFields, type BrainStore, type PageFields } from "./store.js";
import { estimateTokens } from "./text.js";

export interface ImportPage {
  name: string;
  type: string;
  aliases?: string[];
  body?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImportDeletedPage extends ImportPage {
  deletedAt: string;
}

export interface JarvisExport {
  profile?: { body: string; aliases?: string[] };
  pages?: ImportPage[];
  deleted?: ImportDeletedPage[];
  tombstones?: { name: string; purgedAt: string }[];
}

export interface ImportReport {
  counts: { profile: number; pages: number; deleted: number; tombstones: number };
  profileTokens: number;
  budgetTokens: number;
  /** Blocking: nothing is imported while there are any. */
  problems: { page: string; message: string }[];
  warnings: { page?: string; message: string }[];
}

export const IMPORT_NOTE = "imported from jarvis";

const LOOSE_LINK = /\[\[([^[\]]+)\]\]/g;
const validTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const label = (p: { name?: unknown }) => (typeof p?.name === "string" && p.name ? p.name : "(unnamed page)");

interface Checked {
  report: ImportReport;
  profile?: PageFields;
  pages: { fields: PageFields; src: ImportPage }[];
  deleted: { fields: PageFields; src: ImportDeletedPage }[];
  tombstones: { name: string; purgedAt: string }[];
}

/** Refuses an import into a brain that holds anything but an empty profile. */
export function assertEmpty(store: BrainStore): void {
  const others = store.list().filter((p) => !p.isProfile).length + store.deleted().length;
  if (others || store.profile().body.trim()) throw new BrainError("not_empty", "the brain already has pages; an import only goes into an empty brain");
}

/** Validates the whole export against the brain's rules; nothing is written. */
export function checkImport(store: BrainStore, exp: JarvisExport, budget: number): Checked {
  const problems: ImportReport["problems"] = [];
  const warnings: ImportReport["warnings"] = [];
  const list = <T>(v: T[] | undefined, what: string): T[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      problems.push({ page: "(export)", message: `${what} must be a list` });
      return [];
    }
    return v;
  };
  const fields = (p: ImportPage, isProfile = false): PageFields | undefined => {
    try {
      const f = validateFields({ name: p.name, type: p.type as PageFields["type"], aliases: p.aliases ?? [], body: p.body ?? "" }, isProfile);
      const dropped = (p.aliases ?? []).length - f.aliases.length;
      if (dropped > 0) warnings.push({ page: label(p), message: `${dropped} duplicate alias(es) dropped (an alias equal to the name or another alias)` });
      return f;
    } catch (e) {
      problems.push({ page: label(p), message: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  };
  const times = (p: ImportPage | ImportDeletedPage, deleted: boolean) => {
    const bad = (["createdAt", "updatedAt", ...(deleted ? ["deletedAt"] : [])] as const).filter((k) => !validTime((p as unknown as Record<string, unknown>)[k]));
    if (bad.length) problems.push({ page: label(p), message: `missing or invalid ${bad.join(", ")}` });
    return !bad.length;
  };
  const links = (name: string, body: string) => {
    for (const m of body.matchAll(LOOSE_LINK)) {
      if (!isLinkTarget(m[1]!)) warnings.push({ page: name, message: `"[[${m[1]!.slice(0, 40)}${m[1]!.length > 40 ? "…" : ""}]]" isn't a link under Friday's rules (over 80 characters or a line break); it stays as text` });
    }
  };

  // Profile.
  let profile: PageFields | undefined;
  if (exp.profile) {
    const current = store.profile();
    profile = fields({ name: current.name, type: current.type, aliases: exp.profile.aliases ?? [], body: exp.profile.body ?? "", createdAt: current.createdAt, updatedAt: current.updatedAt }, true);
    if (profile) links("Profile", profile.body);
  }

  // Live pages: rules, then names and aliases unique across the import (and the profile's).
  const owners = new Map<string, string>();
  for (const k of [nameKey("Profile"), ...(profile?.aliases ?? []).map(nameKey)]) owners.set(k, "Profile");
  const pages: Checked["pages"] = [];
  for (const src of list(exp.pages, "pages")) {
    const f = fields(src);
    if (!times(src, false) || !f) continue;
    for (const n of [f.name, ...f.aliases]) {
      const k = nameKey(n);
      const other = owners.get(k);
      if (other) problems.push({ page: f.name, message: `"${n}" is also a name or alias of ${other}` });
      else owners.set(k, f.name);
    }
    links(f.name, f.body);
    pages.push({ fields: f, src });
  }

  // Deleted pages: the same rules; they hold no names, so they may repeat live names.
  const deleted: Checked["deleted"] = [];
  for (const src of list(exp.deleted, "deleted")) {
    const f = fields(src);
    if (!times(src, true) || !f) continue;
    deleted.push({ fields: f, src });
  }

  // Tombstones: skipped (with a warning) when they name an imported live page.
  const tombstones: Checked["tombstones"] = [];
  const seen = new Set<string>();
  for (const t of list(exp.tombstones, "tombstones")) {
    if (typeof t?.name !== "string" || !t.name.trim()) {
      problems.push({ page: "(tombstones)", message: "a tombstone has no name" });
      continue;
    }
    const k = nameKey(t.name);
    if (seen.has(k)) continue;
    seen.add(k);
    if (owners.has(k)) {
      warnings.push({ page: owners.get(k), message: `the forgotten name "${t.name}" is used again by ${owners.get(k)}; that tombstone is skipped` });
      continue;
    }
    tombstones.push({ name: t.name, purgedAt: validTime(t.purgedAt) ? t.purgedAt : new Date().toISOString() });
  }

  const profileTokens = estimateTokens(profile?.body ?? store.profile().body);
  if (profileTokens > budget) warnings.push({ page: "Profile", message: `the profile is about ${profileTokens} tokens, over its budget of ${budget}; imported anyway (the budget is soft)` });

  return {
    report: { counts: { profile: profile ? 1 : 0, pages: pages.length, deleted: deleted.length, tombstones: tombstones.length }, profileTokens, budgetTokens: budget, problems, warnings },
    ...(profile ? { profile } : {}),
    pages,
    deleted,
    tombstones,
  };
}

/**
 * Checks, then (unless `dryRun` or there are problems) imports everything in one transaction: the
 * profile, deleted pages, live pages oldest first with Jarvis's times, and tombstones last (a `user`
 * create would lift a tombstone on its names). Throws `not_empty` for a brain that isn't empty.
 */
export function runImport(store: BrainStore, db: ModuleDb, exp: JarvisExport, budget: number, dryRun: boolean): { applied: boolean; report: ImportReport } {
  assertEmpty(store);
  const checked = checkImport(store, exp, budget);
  if (dryRun || checked.report.problems.length) return { applied: false, report: checked.report };
  db.transaction(() => {
    assertEmpty(store);
    if (checked.profile) {
      const p = store.profile();
      store.save(p.id, { ...checked.profile, name: p.name, type: p.type }, "user", { note: IMPORT_NOTE });
    }
    const byUpdate = <T extends { src: ImportPage }>(xs: T[]) => [...xs].sort((a, b) => Date.parse(a.src.updatedAt) - Date.parse(b.src.updatedAt));
    for (const d of byUpdate(checked.deleted)) {
      const page = store.create(d.fields, "user", { note: `${IMPORT_NOTE} (deleted there; created ${d.src.createdAt}, updated ${d.src.updatedAt})` });
      store.setImportedTimes(page.id, { createdAt: d.src.createdAt, updatedAt: d.src.updatedAt, deletedAt: d.src.deletedAt });
    }
    for (const l of byUpdate(checked.pages)) {
      const page = store.create(l.fields, "user", { note: `${IMPORT_NOTE} (created ${l.src.createdAt}, updated ${l.src.updatedAt})` });
      store.setImportedTimes(page.id, { createdAt: l.src.createdAt, updatedAt: l.src.updatedAt });
    }
    for (const t of checked.tombstones) store.addTombstone(t.name, t.purgedAt);
  });
  return { applied: true, report: checked.report };
}
