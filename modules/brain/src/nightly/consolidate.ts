/**
 * Nightly consolidation (design D4): the only rewriter. One model call proposes a plan over the whole
 * brain; the plan is validated (including a mechanical check that nothing is lost without being declared)
 * and applied in one transaction, all or nothing. A refused plan gets one repair round.
 */
import { LlmError, type LlmMessage, type ModuleDb, type ModuleLlm, type ModuleLogger, type ModuleStorage } from "@friday/sdk";
import { indexLine } from "../context.js";
import { nameKey } from "../links.js";
import { fold, significantWords } from "../search.js";
import { BrainError, validateFields, type BrainStore, type Page, type PageType } from "../store.js";
import { estimateTokens } from "../text.js";
import { PAGE_TYPES } from "../types.js";
import { consolidationSystem, GUIDANCE_VERSION } from "./guidance.js";
import type { ConsolidateOutcome } from "./job.js";
import { BRAIN_MAX } from "./render.js";
import type { DroppedLine, MergeRecord } from "./runs.js";

export const MAX_ACTIONS = 20;
/** A removed line counts as preserved when at least this share of its significant words is in the result. */
export const PRESERVED_SHARE = 0.6;
const WATERMARK = "consolidate:last_revision_id";
/** The GUIDANCE_VERSION of the last applied plan; absent means version 1. */
const GUIDANCE = "consolidate:guidance";

const DROPPED = {
  type: "array",
  items: {
    type: "object",
    properties: { line: { type: "string", description: "The removed line, as it was" }, reason: { type: "string" } },
    required: ["line", "reason"],
  },
};

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    // No maxItems: Gemini rejects this schema as too complex with it ("invalid argument"). The 20-action
    // cap is enforced by validatePlan instead, which refuses a longer plan with a reason for the repair round.
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["rewrite", "create", "merge"] },
          page: { type: "string", description: "rewrite: the page id" },
          base: { type: "integer", description: "rewrite: the page's revision shown" },
          from: { type: "string", description: "merge: id of the page folded in and deleted" },
          into: { type: "string", description: "merge: id of the page that stays" },
          fromBase: { type: "integer", description: "merge: the from page's revision shown" },
          intoBase: { type: "integer", description: "merge: the into page's revision shown" },
          name: { type: "string", description: "create: the name; rewrite: a new name (optional)" },
          type: { type: "string", enum: [...PAGE_TYPES] },
          aliases: { type: "array", items: { type: "string" } },
          body: { type: "string", description: "The page's full new body" },
          dropped: DROPPED,
        },
        required: ["kind", "body"],
      },
    },
    note: { type: "string", description: "One sentence summarizing the plan" },
  },
  required: ["actions", "note"],
};

export interface PlanAction {
  kind: "rewrite" | "create" | "merge";
  page?: string;
  base?: number;
  from?: string;
  into?: string;
  fromBase?: number;
  intoBase?: number;
  name?: string;
  type?: PageType;
  aliases?: string[];
  body: string;
  dropped?: { line: string; reason: string }[];
}

export interface Plan {
  actions: PlanAction[];
  note: string;
}

export interface ConsolidateDeps {
  store: BrainStore;
  db: ModuleDb;
  llm: ModuleLlm;
  storage: ModuleStorage;
  log: ModuleLogger;
  /** BRAIN_PROFILE_TOKEN_BUDGET. */
  budget: () => number;
}

function pageBlock(p: Page, changed: boolean): string {
  return `### ${p.name} [id ${p.id}, revision ${p.revisionId}]${changed ? " (changed)" : ""}\ntype ${p.type}; aliases: ${p.aliases.join(", ") || "none"}${p.isProfile ? "; this is the profile" : ""}\n${p.body.trim() || "(empty)"}`;
}

/**
 * The plan's input: the profile budget, pages in full (the profile, changed pages and their link
 * neighbours first, then the rest until `max`), an index of pages beyond the bound, and forgotten names.
 */
export function renderConsolidation(store: BrainStore, changed: ReadonlySet<string>, budget: number, max = BRAIN_MAX, guidanceChanged = false): string {
  return consolidationInput(store, changed, budget, max, guidanceChanged).text;
}

/** `renderConsolidation`, plus the ids of the pages shown in full (the only ones a plan may change). */
export function consolidationInput(store: BrainStore, changed: ReadonlySet<string>, budget: number, max = BRAIN_MAX, guidanceChanged = false): { text: string; full: Set<string> } {
  const pages = store.list();
  const profile = pages.find((p) => p.isProfile)!;
  const used = estimateTokens(profile.body);
  const header = [
    `Profile budget: about ${used} of ${budget} tokens${used > budget ? " (over budget: move detail to entity pages; don't make it longer)" : ""}.`,
    "Only pages shown in full may be rewritten or merged.",
    ...(guidanceChanged ? ["The guidance changed since the last tidy-up; check the profile against it."] : []),
  ].join("\n");
  const forgotten = store.tombstones().map((t) => t.name);
  const tail = `## Deliberately forgotten names (never use)\n${forgotten.length ? forgotten.map((n) => `- ${n}`).join("\n") : "(none)"}`;

  // Changed pages and their link neighbours (outgoing links and backlinks) come first.
  const neighbours = new Set<string>();
  for (const p of pages) {
    if (!changed.has(p.id)) continue;
    for (const l of store.links(p)) if (l.pageId) neighbours.add(l.pageId);
    for (const b of store.backlinks(p)) neighbours.add(b.pageId);
  }
  const rank = (p: Page) => (p.isProfile ? 0 : changed.has(p.id) ? 1 : neighbours.has(p.id) ? 2 : 3);
  const ordered = [...pages].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));

  const blocks: string[] = [];
  const index: string[] = [];
  const full = new Set<string>();
  let size = header.length + tail.length + 100;
  for (const p of ordered) {
    const b = pageBlock(p, changed.has(p.id));
    if (!index.length && (size + b.length + 2 <= max || p.isProfile)) {
      blocks.push(b);
      full.add(p.id);
      size += b.length + 2;
    } else index.push(indexLine(p));
  }
  const text = [header, "## Pages", ...blocks, ...(index.length ? [`## Other pages (index only, not in full)\n${index.join("\n")}`] : []), tail].join("\n\n");
  return { text, full };
}

/** A line's content without list markers and a note's date prefix. */
function content(line: string): string {
  return line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/, "").replace(/^\d{4}-\d{2}-\d{2}:\s*/, "").trim();
}

const same = (a: string, b: string) => {
  const x = fold(content(a)).replace(/\s+/g, " ");
  const y = fold(content(b)).replace(/\s+/g, " ");
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

/**
 * Whether most significant words of `line` occur as words of `result` (the plan's resulting text).
 * Words match whole, or by a shared prefix of at least 4 letters for plurals and inflections
 * ("birthday"/"birthdays", "verjaardag"/"verjaardagen"); numbers only match exactly, so a "2" isn't
 * found inside a date and "cats" isn't found inside another word.
 */
export function preserved(line: string, result: string | ReadonlySet<string>): boolean {
  const words = significantWords(content(line));
  if (!words.length) return true;
  const tokens = typeof result === "string" ? new Set(significantWords(result)) : result;
  const found = (w: string) => {
    if (tokens.has(w)) return true;
    if (/^\p{N}+$/u.test(w) || w.length < 4) return false;
    for (const t of tokens) if (t.length >= 4 && (t.startsWith(w) || w.startsWith(t))) return true;
    return false;
  };
  return words.filter(found).length / words.length >= PRESERVED_SHARE;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The live pages a line names (design D3): `[[link]]` targets, and names or aliases that occur in it as whole words.
 * The name patterns are built on the first line that needs them, once per plan; the brain is small, so testing
 * every name against a removed line is cheap. Links resolve as everywhere else (`store.links`, code is not a link).
 */
function namedPagesFinder(store: BrainStore): (line: string) => Page[] {
  let names: { page: Page; word: RegExp }[] | undefined;
  return (line) => {
    names ??= store.list().flatMap((p) =>
      [p.name, ...p.aliases].map((n) => ({ page: p, word: new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(fold(n).trim().replace(/\s+/g, " "))}(?:$|[^\\p{L}\\p{N}])`, "u") })),
    );
    const found = new Map<string, Page>();
    const byId = new Map(names.map((n) => [n.page.id, n.page]));
    for (const l of store.links({ body: line })) {
      const p = l.pageId ? byId.get(l.pageId) : undefined;
      if (p) found.set(p.id, p);
    }
    const text = fold(line).replace(/\s+/g, " ");
    for (const n of names) if (n.word.test(text)) found.set(n.page.id, n.page);
    return [...found.values()];
  };
}

/**
 * Whether `page` states `line`: most of the line's significant words, other than the page's own names, are in its
 * body. The names don't count, or "My brother Mark is a cellist" would pass on a page that only says "brother".
 */
function statedOn(line: string, page: Page): boolean {
  const own = new Set(significantWords([page.name, ...page.aliases].join("\n")));
  const rest = significantWords(content(line)).filter((w) => !own.has(w));
  return rest.length > 0 && preserved(rest.join(" "), page.body);
}

/** Everything wrong with `plan`, as reasons for the model; empty when it may be applied. */
/** `shown`: the pages the model saw in full; only those may be rewritten or merged (all when omitted). */
export function validatePlan(store: BrainStore, plan: Plan, budget: number, shown?: ReadonlySet<string>): string[] {
  const reasons: string[] = [];
  if (!plan || !Array.isArray(plan.actions)) return ["the answer has no list of actions"];
  if (plan.actions.length > MAX_ACTIONS) reasons.push(`the plan has ${plan.actions.length} actions; at most ${MAX_ACTIONS}`);
  const tombstoned = new Set(store.tombstones().map((t) => t.key));
  const touched = new Map<string, number>();
  const mergedAway = new Set(plan.actions.filter((a) => a.kind === "merge" && a.from).map((a) => a.from!));
  const resultText = plan.actions.map((a) => `${a.name ?? ""}\n${(a.aliases ?? []).join("\n")}\n${a.body ?? ""}`).join("\n");
  const resultWords = new Set(significantWords(resultText));
  const label = (i: number, a: PlanAction) => `action ${i + 1} (${a.kind})`;
  // A removed line is also kept when a page it names, and that the plan leaves alone, already states it (design D3).
  // A page the plan changes is judged by its new body, which is part of the result text above.
  const namedIn = namedPagesFinder(store);
  const changedByPlan = new Set(plan.actions.flatMap((a) => [a?.page, a?.from, a?.into]).filter((id): id is string => typeof id === "string"));
  const keptOnNamedPage = (line: string, own: Page) => namedIn(line).some((p) => p.id !== own.id && !changedByPlan.has(p.id) && statedOn(line, p));

  const live = (i: number, a: PlanAction, id: string | undefined, base: number | undefined, role: string): Page | undefined => {
    const p = id ? store.get(id) : undefined;
    if (!p) return void reasons.push(`${label(i, a)}: ${role} ${JSON.stringify(id)} doesn't exist`);
    if (p.deletedAt) return void reasons.push(`${label(i, a)}: ${role} ${p.name} is deleted`);
    if (base !== p.revisionId) return void reasons.push(`${label(i, a)}: ${role} ${p.name} is stale: its current revision is ${p.revisionId}, not ${base}`);
    if (shown && !shown.has(p.id)) return void reasons.push(`${label(i, a)}: ${p.name} was only in the index, not shown in full, so it can't be changed tonight`);
    const prev = touched.get(p.id);
    if (prev !== undefined) reasons.push(`${label(i, a)}: ${p.name} is already changed by action ${prev + 1}; one action per page`);
    touched.set(p.id, i);
    return p;
  };
  const nameOk = (i: number, a: PlanAction, name: string, self?: string) => {
    const key = nameKey(name);
    if (tombstoned.has(key)) reasons.push(`${label(i, a)}: "${name}" was deliberately forgotten and may not be used`);
    const owner = store.resolve(name);
    if (owner && owner.id !== self && !mergedAway.has(owner.id)) reasons.push(`${label(i, a)}: the name "${name}" is already used by ${owner.name}`);
  };
  const lossCheck = (i: number, a: PlanAction, old: Page[]) => {
    for (const p of old) {
      for (const line of p.body.split("\n")) {
        const c = content(line);
        if (!c || /^#{1,6}(\s|$)/.test(line.trim())) continue;
        if (resultText.includes(c) || preserved(c, resultWords) || keptOnNamedPage(c, p)) continue;
        if ((a.dropped ?? []).some((d) => typeof d?.line === "string" && same(d.line, line))) continue;
        reasons.push(`${label(i, a)}: ${p.name} loses the line "${line.trim()}" without declaring it in dropped`);
      }
    }
  };

  plan.actions.forEach((a, i) => {
    if (!a || !["rewrite", "create", "merge"].includes(a.kind)) return void reasons.push(`action ${i + 1}: unknown kind ${JSON.stringify(a?.kind)}`);
    if (typeof a.body !== "string" || !a.body.trim()) reasons.push(`${label(i, a)}: the body is empty`);
    if (a.kind === "rewrite") {
      const p = live(i, a, a.page, a.base, "page");
      if (!p) return;
      if (p.isProfile && ((a.name !== undefined && a.name !== p.name) || (a.type !== undefined && a.type !== p.type))) reasons.push(`${label(i, a)}: the profile's name and type can't change`);
      if (a.name !== undefined && nameKey(a.name) !== nameKey(p.name)) nameOk(i, a, a.name, p.id);
      try {
        validateFields({ name: a.name ?? p.name, type: a.type ?? p.type, aliases: a.aliases ?? p.aliases, body: a.body }, p.isProfile);
      } catch (e) {
        reasons.push(`${label(i, a)}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (p.isProfile) {
        const before = estimateTokens(p.body);
        if (before > budget && estimateTokens(a.body ?? "") > before) reasons.push(`${label(i, a)}: the profile is over budget (${before} of ${budget} tokens) and the plan makes it larger`);
      }
      lossCheck(i, a, [p]);
    } else if (a.kind === "create") {
      if (typeof a.name !== "string") return void reasons.push(`${label(i, a)}: a new page needs a name`);
      nameOk(i, a, a.name);
      try {
        validateFields({ name: a.name, type: a.type ?? "other", aliases: a.aliases ?? [], body: a.body });
      } catch (e) {
        reasons.push(`${label(i, a)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      const from = live(i, a, a.from, a.fromBase, "from");
      const into = live(i, a, a.into, a.intoBase, "into");
      if (!from || !into) return;
      if (from.id === into.id) return void reasons.push(`${label(i, a)}: a page can't be merged into itself`);
      if (from.isProfile || into.isProfile) return void reasons.push(`${label(i, a)}: the profile can't be merged`);
      lossCheck(i, a, [from, into]);
    }
  });
  return reasons;
}

interface Applied {
  rewrites: number;
  creates: number;
  merges: MergeRecord[];
  dropped: DroppedLine[];
}

/** Applies a validated plan in one transaction. A store error rolls everything back and is rethrown. */
export function applyPlan(store: BrainStore, db: ModuleDb, plan: Plan): Applied {
  return db.transaction(() => {
    const out: Applied = { rewrites: 0, creates: 0, merges: [], dropped: [] };
    const note = typeof plan.note === "string" && plan.note.trim() ? plan.note.trim().slice(0, 300) : "nightly consolidation";
    const dropped = (p: Page, a: PlanAction) => {
      for (const d of a.dropped ?? []) out.dropped.push({ pageId: p.id, page: p.name, line: String(d.line), reason: String(d.reason) });
    };
    for (const a of plan.actions) {
      if (a.kind === "rewrite") {
        const p = store.get(a.page!)!;
        store.save(p.id, { name: a.name ?? p.name, type: a.type ?? p.type, aliases: a.aliases ?? p.aliases, body: a.body }, "consolidation", { base: a.base, note });
        dropped(p, a);
        out.rewrites++;
      } else if (a.kind === "create") {
        store.create({ name: a.name, type: a.type ?? "other", aliases: a.aliases ?? [], body: a.body }, "consolidation", { note });
        out.creates++;
      } else {
        const from = store.get(a.from!)!;
        const into = store.get(a.into!)!;
        // Free the absorbed page's names first, so they can become the target's aliases.
        store.softDelete(from.id, "consolidation", { base: a.fromBase, note: `merged into ${into.name}` });
        const aliases = [...into.aliases, ...(a.aliases ?? []), from.name, ...from.aliases].filter((n) => nameKey(n) !== nameKey(into.name));
        store.save(into.id, { name: into.name, type: into.type, aliases, body: a.body }, "consolidation", { base: a.intoBase, note, keepOldName: false });
        dropped(into, a);
        out.merges.push({ from: from.id, into: into.id });
      }
    }
    return out;
  });
}

const EMPTY: Omit<ConsolidateOutcome, "ran"> = { rewrites: 0, creates: 0, merges: [], dropped: [] };

/** One consolidation step: skipped when nothing changed; otherwise plan, validate, apply, repair once. */
export async function runConsolidate(deps: ConsolidateDeps, signal: AbortSignal): Promise<ConsolidateOutcome> {
  const since = (await deps.storage.get<number>(WATERMARK)) ?? 0;
  // Taken before the model is asked: a change made while it thinks (minutes) is still "changed" next time.
  const seenUpTo = deps.store.lastRevisionId();
  const changes = deps.store.changesSince(since);
  const changed = new Set(changes.keys());
  // A brain consolidated under older guidance is reconsidered once, with the profile as the changed page (design D2).
  const guidanceChanged = ((await deps.storage.get<number>(GUIDANCE)) ?? 1) < GUIDANCE_VERSION;
  if (guidanceChanged) {
    const profile = deps.store.profile();
    if (!changed.size && !profile.body.trim() && deps.store.count() === 0) {
      // Only an empty profile: nothing to reconsider, and no model call on a fresh install's first night.
      await deps.storage.set(GUIDANCE, GUIDANCE_VERSION);
      return { ran: false, ...EMPTY };
    }
    changed.add(profile.id);
  }
  if (!changed.size) return { ran: false, ...EMPTY };
  const budget = deps.budget();
  const input = consolidationInput(deps.store, changed, budget, BRAIN_MAX, guidanceChanged);
  const prompt = `${input.text}\n\nPropose the plan (an empty plan is fine when the pages are tidy).`;
  // Changed pages beyond the bound were only indexed: stop the watermark before their first change.
  const unseen = [...changes].filter(([id]) => !input.full.has(id)).map(([, first]) => first);
  const nextWatermark = unseen.length ? Math.min(...unseen) - 1 : seenUpTo;
  const request = { system: consolidationSystem(), schema: PLAN_SCHEMA, model: "standard" as const, temperature: 0.2, maxOutputTokens: 32768, timeoutMs: 300_000, signal };

  const attempt = async (messages: LlmMessage[]): Promise<{ plan?: Plan; raw: string; reasons: string[]; applied?: Applied; fatal?: string }> => {
    let raw = "";
    let plan: Plan | undefined;
    try {
      const r = await deps.llm.generate<Plan>({ ...request, messages });
      raw = r.text;
      plan = r.json;
    } catch (e) {
      if (!(e instanceof LlmError)) throw e;
      if (e.kind === "invalid_output" || e.kind === "blocked") return { raw: e.raw ?? "", reasons: [`the answer was not a valid plan (${e.kind}: ${e.message})`] };
      return { raw, reasons: [], fatal: e.kind === "cancelled" ? "cancelled" : `model ${e.kind}: ${e.message}` };
    }
    const reasons = validatePlan(deps.store, plan!, budget, input.full);
    if (reasons.length) return { plan, raw, reasons };
    try {
      return { plan, raw, reasons: [], applied: applyPlan(deps.store, deps.db, plan!) };
    } catch (e) {
      if (!(e instanceof BrainError)) throw e;
      return { plan, raw, reasons: [`applying the plan failed: ${e.message}`] };
    }
  };

  const first = await attempt([{ role: "user", text: prompt }]);
  let result = first;
  if (!first.applied && !first.fatal) {
    deps.log.log(`nightly: consolidation plan refused (${first.reasons.length} reasons); asking for a repair`);
    result = await attempt([
      { role: "user", text: prompt },
      { role: "model", text: first.raw || JSON.stringify(first.plan ?? {}) },
      { role: "user", text: `The plan was refused, and nothing was changed:\n${first.reasons.map((r) => `- ${r}`).join("\n")}\n\nRevise the plan to fix these. An empty plan is fine.` },
    ]);
  }
  if (!result.applied) {
    const failed = result.fatal ?? `consolidation plan refused twice: ${result.reasons.join("; ")}`;
    deps.log.warn(`nightly: ${failed}`);
    return { ran: true, ...EMPTY, failed };
  }
  await deps.storage.set(WATERMARK, nextWatermark);
  await deps.storage.set(GUIDANCE, GUIDANCE_VERSION);
  return { ran: true, ...result.applied };
}
