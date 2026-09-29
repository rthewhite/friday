/**
 * One-off import of a Jarvis user's brain into an empty brain (change brain-import, design D2/D3).
 * Everything goes through the store's validation; the whole import is one transaction, and a dry
 * run reports what would happen without writing anything.
 */
import type { ModuleDb } from "@friday/sdk";
import { isLinkTarget, looseLinkTargets, nameKey } from "./links.js";
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

/** A time Jarvis wrote, as the ISO string the brain sorts by; undefined when it isn't a time. */
const isoTime = (v: unknown): string | undefined => {
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return undefined;
  return new Date(v).toISOString();
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const label = (p: unknown) => (isObject(p) && typeof p.name === "string" && p.name ? p.name : "(unnamed page)");

interface Times {
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

interface Checked {
  report: ImportReport;
  profile?: PageFields;
  pages: { fields: PageFields; times: Times }[];
  deleted: { fields: PageFields; times: Times }[];
  tombstones: { name: string; purgedAt: string }[];
}

/** Refuses an import into a brain that holds anything but an empty profile (no text, no aliases). */
export function assertEmpty(store: BrainStore): void {
  const profile = store.profile();
  if (store.count() || store.deleted().length || profile.body.trim() || profile.aliases.length) {
    throw new BrainError("not_empty", "the brain already has pages; an import only goes into an empty brain");
  }
}

/** Validates the whole export against the brain's rules; nothing is written. */
export function checkImport(store: BrainStore, exp: JarvisExport, budget: number): Checked {
  const problems: ImportReport["problems"] = [];
  const warnings: ImportReport["warnings"] = [];
  const list = (v: unknown, what: string): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      problems.push({ page: "(export)", message: `${what} must be a list` });
      return [];
    }
    return v;
  };
  const fields = (p: Record<string, unknown>, isProfile = false): PageFields | undefined => {
    try {
      const aliases = (p.aliases ?? []) as string[];
      const f = validateFields({ name: p.name as string, type: p.type as PageFields["type"], aliases, body: (p.body ?? "") as string }, isProfile);
      const dropped = (Array.isArray(aliases) ? aliases.length : 0) - f.aliases.length;
      if (dropped > 0) warnings.push({ page: label(p), message: `${dropped} duplicate alias(es) dropped (an alias equal to the name or another alias)` });
      return f;
    } catch (e) {
      problems.push({ page: label(p), message: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  };
  const times = (p: Record<string, unknown>, deleted: boolean): Times | undefined => {
    const keys = ["createdAt", "updatedAt", ...(deleted ? ["deletedAt"] : [])];
    const bad = keys.filter((k) => !isoTime(p[k]));
    if (bad.length) {
      problems.push({ page: label(p), message: `missing or invalid ${bad.join(", ")}` });
      return undefined;
    }
    return { createdAt: isoTime(p.createdAt)!, updatedAt: isoTime(p.updatedAt)!, ...(deleted ? { deletedAt: isoTime(p.deletedAt)! } : {}) };
  };
  const links = (name: string, body: string) => {
    for (const target of looseLinkTargets(body)) {
      if (!isLinkTarget(target)) warnings.push({ page: name, message: `"[[${target.slice(0, 40)}${target.length > 40 ? "…" : ""}]]" isn't a link under Friday's rules (over 80 characters or a line break); it stays as text` });
    }
  };
  const entries = (v: unknown, what: string): Record<string, unknown>[] =>
    list(v, what).filter((p): p is Record<string, unknown> => {
      if (isObject(p)) return true;
      problems.push({ page: `(${what})`, message: `an entry is not an object: ${JSON.stringify(p)}` });
      return false;
    });

  // Profile.
  let profile: PageFields | undefined;
  if (exp.profile !== undefined) {
    const current = store.profile();
    if (!isObject(exp.profile) || typeof exp.profile.body !== "string") {
      problems.push({ page: "Profile", message: "the profile must be an object with a text body" });
    } else {
      profile = fields({ name: current.name, type: current.type, aliases: exp.profile.aliases ?? [], body: exp.profile.body }, true);
      if (profile) links("Profile", profile.body);
    }
  }

  // Live pages: rules, then names and aliases unique across the import (and the profile's). Names of
  // pages with other problems still count, so every collision shows up in the same report.
  const owners = new Map<string, string>();
  for (const k of [nameKey("Profile"), ...(profile?.aliases ?? []).map(nameKey)]) owners.set(k, "Profile");
  const claim = (page: string, names: unknown[]) => {
    for (const n of names) {
      if (typeof n !== "string" || !n.trim()) continue;
      const k = nameKey(n);
      const other = owners.get(k);
      if (other && other !== page) problems.push({ page, message: `"${n.trim()}" is also a name or alias of ${other}` });
      else owners.set(k, page);
    }
  };
  const pages: Checked["pages"] = [];
  for (const src of entries(exp.pages, "pages")) {
    const f = fields(src);
    const t = times(src, false);
    claim(f?.name ?? label(src), f ? [f.name, ...f.aliases] : [src.name, ...(Array.isArray(src.aliases) ? src.aliases : [])]);
    if (!f || !t) continue;
    links(f.name, f.body);
    pages.push({ fields: f, times: t });
  }

  // Deleted pages: the same rules; they hold no names, so they may repeat live names.
  const deleted: Checked["deleted"] = [];
  for (const src of entries(exp.deleted, "deleted")) {
    const f = fields(src);
    const t = times(src, true);
    if (f && t) deleted.push({ fields: f, times: t });
  }

  // Tombstones: skipped (with a warning) when they name an imported live page.
  const tombstones: Checked["tombstones"] = [];
  const seen = new Set<string>();
  for (const t of entries(exp.tombstones, "tombstones")) {
    if (typeof t.name !== "string" || !t.name.trim()) {
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
    tombstones.push({ name: t.name, purgedAt: isoTime(t.purgedAt) ?? new Date().toISOString() });
  }

  // Names this brain forgot before: an imported page with one of them brings it back.
  for (const f of store.tombstones()) {
    const owner = owners.get(f.key);
    if (owner && owner !== "Profile") warnings.push({ page: owner, message: `"${f.name}" was deliberately forgotten in this brain; importing ${owner} brings the name back` });
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
 * Checks, then (unless `dryRun` or there are problems) imports everything in one transaction:
 * deleted pages first (they are created live, then marked deleted, so they must not meet the
 * profile's or live pages' names), then the profile, live pages oldest first with Jarvis's times,
 * and tombstones last (a `user` create would lift a tombstone on its names). A store error rolls
 * everything back and is returned as a problem. Throws `not_empty` for a brain that isn't empty.
 */
export function runImport(store: BrainStore, db: ModuleDb, exp: JarvisExport, budget: number, dryRun: boolean): { applied: boolean; report: ImportReport } {
  assertEmpty(store);
  const checked = checkImport(store, exp, budget);
  if (dryRun || checked.report.problems.length) return { applied: false, report: checked.report };
  const byUpdate = <T extends { times: Times }>(xs: T[]) => [...xs].sort((a, b) => a.times.updatedAt.localeCompare(b.times.updatedAt));
  try {
    db.transaction(() => {
      assertEmpty(store);
      for (const d of byUpdate(checked.deleted)) {
        const page = store.create(d.fields, "user", { note: `${IMPORT_NOTE} (deleted there; created ${d.times.createdAt}, updated ${d.times.updatedAt})` });
        store.setImportedTimes(page.id, d.times);
      }
      if (checked.profile) {
        const p = store.profile();
        store.save(p.id, { ...checked.profile, name: p.name, type: p.type }, "user", { note: IMPORT_NOTE });
      }
      for (const l of byUpdate(checked.pages)) {
        const page = store.create(l.fields, "user", { note: `${IMPORT_NOTE} (created ${l.times.createdAt}, updated ${l.times.updatedAt})` });
        store.setImportedTimes(page.id, l.times);
      }
      for (const t of checked.tombstones) store.addTombstone(t.name, t.purgedAt);
    });
  } catch (e) {
    if (!(e instanceof BrainError) || e.code === "not_empty") throw e;
    const report = { ...checked.report, problems: [...checked.report.problems, { page: e.names?.join(", ") || "(import)", message: `the import failed and was rolled back: ${e.message}` }] };
    return { applied: false, report };
  }
  return { applied: true, report: checked.report };
}
