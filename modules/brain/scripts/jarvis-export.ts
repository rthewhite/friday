/**
 * Reads one user's brain from a copy of Jarvis's SQLite file (`jarvis-brain-memories.db`) and turns it
 * into the payload of `POST /api/modules/brain/import`. Read-only; the legacy `memories` table and the
 * revision history are never read.
 */
import { DatabaseSync } from "node:sqlite";
import type { JarvisExport } from "../src/import.js";

interface DocumentRow {
  name: string;
  type: string;
  aliases: string;
  body: string;
  is_profile: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReadResult {
  payload: JarvisExport;
  /** Things worth telling the user before the dry run (e.g. aliases that weren't valid JSON). */
  notes: string[];
}

/** The usernames that have documents in the file. */
export function jarvisUsers(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT DISTINCT username FROM documents ORDER BY username").all() as { username: string }[]).map((r) => r.username);
  } finally {
    db.close();
  }
}

export function readJarvisExport(file: string, user: string): ReadResult {
  const db = new DatabaseSync(file, { readOnly: true });
  const notes: string[] = [];
  try {
    const docs = db
      .prepare("SELECT name, type, aliases, body, is_profile, deleted_at, created_at, updated_at FROM documents WHERE username = ? ORDER BY updated_at, name")
      .all(user) as unknown as DocumentRow[];
    const aliases = (d: DocumentRow): string[] => {
      try {
        const a = JSON.parse(d.aliases || "[]") as unknown;
        if (Array.isArray(a) && a.every((x) => typeof x === "string")) return a;
      } catch {
        // reported below
      }
      notes.push(`${d.name}: aliases ${JSON.stringify(d.aliases)} are not a JSON list of strings; imported without aliases`);
      return [];
    };
    const page = (d: DocumentRow) => ({ name: d.name, type: d.type, aliases: aliases(d), body: d.body ?? "", createdAt: d.created_at, updatedAt: d.updated_at });

    const profiles = docs.filter((d) => d.is_profile === 1 && !d.deleted_at);
    if (profiles.length > 1) notes.push(`${profiles.length} live profiles for ${user}; the most recently updated is imported`);
    const profile = profiles.at(-1);
    const tombstones = (db.prepare("SELECT name_lower, purged_at FROM document_tombstones WHERE username = ? ORDER BY name_lower").all(user) as { name_lower: string; purged_at: string }[])
      .map((t) => ({ name: t.name_lower, purgedAt: t.purged_at }));
    return {
      payload: {
        ...(profile ? { profile: { body: profile.body ?? "", aliases: aliases(profile) } } : {}),
        pages: docs.filter((d) => d.is_profile !== 1 && !d.deleted_at).map(page),
        deleted: docs.filter((d) => d.is_profile !== 1 && d.deleted_at).map((d) => ({ ...page(d), deletedAt: d.deleted_at! })),
        tombstones,
      },
      notes,
    };
  } finally {
    db.close();
  }
}
