/**
 * One-off: import a Jarvis user's brain into an empty Friday brain (change brain-import).
 *
 *   pnpm --filter @friday/module-brain import-jarvis --db ~/jarvis-brain-export.db [--user rdewit] [--friday http://localhost:8080] [--apply]
 *
 * Always runs a dry run first and prints its report. With --apply it imports, but only when the dry
 * run found no problems. The Friday brain must be empty (only its empty profile).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ImportReport } from "../src/import.js";
import { jarvisUsers, readJarvisExport } from "./jarvis-export.js";

/** Core reads at most this many bytes of a request body. */
const MAX_BYTES = 1_000_000;

const HELP = `Import a Jarvis user's brain into an empty Friday brain.

  --db <file>       copy of Jarvis's jarvis-brain-memories.db (required; opened read-only)
  --user <name>     Jarvis username to import (default rdewit)
  --friday <url>    Friday's base URL (default http://localhost:8080)
  --apply           import after a clean dry run (without it, only the dry run runs)
  --help            this text`;

function args(argv: string[]) {
  const out: { db?: string; user: string; friday: string; apply: boolean; help: boolean } = { user: "rdewit", friday: "http://localhost:8080", apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--db") out.db = value();
    else if (a === "--user") out.user = value();
    else if (a === "--friday") out.friday = value().replace(/\/+$/, "");
    else if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a !== "--") throw new Error(`unknown argument ${a} (see --help)`);
  }
  return out;
}

function printReport(r: ImportReport) {
  const c = r.counts;
  console.log(`  profile: ${c.profile ? `yes, about ${r.profileTokens} of ${r.budgetTokens} tokens` : "none"}`);
  console.log(`  pages: ${c.pages} live, ${c.deleted} deleted; tombstones: ${c.tombstones}`);
  for (const w of r.warnings) console.log(`  warning${w.page ? ` (${w.page})` : ""}: ${w.message}`);
  for (const p of r.problems) console.log(`  PROBLEM (${p.page}): ${p.message}`);
}

async function send(friday: string, body: object): Promise<{ status: number; body: { applied?: boolean; report?: ImportReport; error?: string; code?: string } }> {
  const res = await fetch(`${friday}/api/modules/brain/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as never };
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.help || !o.db) {
    console.log(HELP);
    process.exit(o.help ? 0 : 2);
  }
  const file = resolve(o.db.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  if (!existsSync(file)) throw new Error(`${file} doesn't exist`);
  const users = jarvisUsers(file);
  if (!users.includes(o.user)) throw new Error(`no documents for user "${o.user}" in ${file} (users: ${users.join(", ") || "none"})`);

  const { payload, notes } = readJarvisExport(file, o.user);
  console.log(`Jarvis brain of ${o.user} (${file}): profile ${payload.profile ? "yes" : "no"}, ${payload.pages!.length} live pages, ${payload.deleted!.length} deleted, ${payload.tombstones!.length} tombstones`);
  for (const n of notes) console.log(`  note: ${n}`);
  const bytes = Buffer.byteLength(JSON.stringify({ ...payload, dryRun: false }));
  if (bytes > MAX_BYTES) throw new Error(`the export is ${bytes} bytes; Friday accepts at most ${MAX_BYTES} in one request, and the import must be one request`);

  console.log(`\nDry run against ${o.friday}:`);
  const dry = await send(o.friday, { ...payload, dryRun: true });
  if (dry.status !== 200 || !dry.body.report) throw new Error(`dry run failed: ${dry.status} ${dry.body.error ?? JSON.stringify(dry.body)}`);
  printReport(dry.body.report);
  if (dry.body.report.problems.length) {
    console.log(`\n${dry.body.report.problems.length} problem(s): fix them in Jarvis (or in the copy) and run again. Nothing was imported.`);
    process.exit(1);
  }
  if (!o.apply) {
    console.log("\nDry run clean. Run again with --apply to import.");
    return;
  }
  const real = await send(o.friday, { ...payload, dryRun: false });
  if (real.status !== 200 || !real.body.applied) throw new Error(`import failed: ${real.status} ${real.body.error ?? JSON.stringify(real.body)}`);
  console.log(`\nImported into ${o.friday}: ${real.body.report!.counts.pages} pages, ${real.body.report!.counts.deleted} deleted, ${real.body.report!.counts.tombstones} tombstones.`);
}

main().catch((e) => {
  console.error(`import-jarvis: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
