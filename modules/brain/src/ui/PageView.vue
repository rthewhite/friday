<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Badge, Button, Card, Chip, Icon, Input, PageLayout, Tabs, formatDateTime } from "@friday/portal-ui";
import { lineDiff } from "./lib/diff.js";
import { renderBody } from "./lib/markdown.js";
import { ApiError, PAGE_TYPES, api, nameKey, parseAliases, type PageDetail, type PageType, type RevisionDetail } from "./lib/pages.js";

const route = useRoute();
const router = useRouter();
const id = computed(() => String(route.params.id ?? ""));

const page = ref<PageDetail | null>(null);
const error = ref("");
const tab = ref("page");

async function load() {
  error.value = "";
  try {
    page.value = await api<PageDetail>("GET", `pages/${encodeURIComponent(id.value)}`);
  } catch (e) {
    page.value = null;
    error.value = e instanceof Error ? e.message : String(e);
  }
}
// ---- Rendering ----
const resolved = computed(() => new Map((page.value?.links ?? []).filter((l) => l.pageId).map((l) => [nameKey(l.target), l.pageId!])));
const html = computed(() => (page.value ? renderBody(page.value.body, (t) => resolved.value.get(nameKey(t))) : ""));
/** Links in the rendered body navigate inside the portal: to a page, or to "New page" for a dangling one. */
function onBodyClick(e: MouseEvent) {
  const a = (e.target as HTMLElement | null)?.closest("a");
  if (!a) return;
  const to = a.getAttribute("data-brain-page");
  const create = a.getAttribute("data-brain-new");
  if (to !== null) {
    e.preventDefault();
    void router.push(`/m/brain/p/${encodeURIComponent(to)}`);
  } else if (create !== null) {
    e.preventDefault();
    void router.push({ path: "/m/brain", query: { new: create } });
  }
}

const subtitle = computed(() => {
  const p = page.value;
  if (!p) return "";
  return [p.isProfile ? "about you and the household" : p.type, p.aliases.length ? `aka ${p.aliases.join(", ")}` : "", `updated ${formatDateTime(p.updatedAt)}`].filter(Boolean).join(" · ");
});

// ---- Edit ----
const editing = ref(false);
const draft = ref<{ name: string; type: PageType; aliases: string; body: string; keepOldName: boolean }>({ name: "", type: "other", aliases: "", body: "", keepOldName: true });
const base = ref(0);
const saveError = ref("");
const conflict = ref<{ author: string; at: string; revisionId: number } | null>(null);
const renamed = computed(() => !!page.value && nameKey(draft.value.name) !== nameKey(page.value.name));

function startEdit() {
  const p = page.value!;
  draft.value = { name: p.name, type: p.type, aliases: p.aliases.join(", "), body: p.body, keepOldName: true };
  base.value = p.revisionId;
  saveError.value = "";
  conflict.value = null;
  editing.value = true;
}
async function save() {
  saveError.value = "";
  try {
    await api("PUT", `pages/${encodeURIComponent(id.value)}`, {
      name: draft.value.name,
      type: draft.value.type,
      aliases: parseAliases(draft.value.aliases),
      body: draft.value.body,
      baseRevision: base.value,
      keepOldName: draft.value.keepOldName,
    });
    editing.value = false;
    conflict.value = null;
    await load();
  } catch (e) {
    if (e instanceof ApiError && e.code === "stale") {
      // Keep the user's text; say who changed the page, and let them discard or overwrite.
      try {
        const current = await api<PageDetail>("GET", `pages/${encodeURIComponent(id.value)}`);
        const latest = current.revisions[0];
        conflict.value = { author: latest?.author ?? "someone", at: latest?.createdAt ?? current.updatedAt, revisionId: current.revisionId };
      } catch (again) {
        saveError.value = `The page changed since you opened it, and reloading it failed: ${again instanceof Error ? again.message : String(again)}. Your text is still here.`;
      }
      return;
    }
    saveError.value = e instanceof Error ? e.message : String(e);
  }
}
async function discard() {
  editing.value = false;
  conflict.value = null;
  await load();
}
async function overwrite() {
  if (!conflict.value) return;
  base.value = conflict.value.revisionId;
  conflict.value = null;
  await save();
}

// ---- Delete ----
const confirmingDelete = ref(false);
const actionError = ref("");
async function remove() {
  actionError.value = "";
  try {
    await api("DELETE", `pages/${encodeURIComponent(id.value)}`);
    await router.push("/m/brain");
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e);
  }
}
async function undelete() {
  actionError.value = "";
  try {
    await api("POST", `pages/${encodeURIComponent(id.value)}/undelete`);
    await load();
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e);
  }
}

// ---- History ----
const selected = ref<{ rev: RevisionDetail; previous?: RevisionDetail } | null>(null);
const historyError = ref("");
const tabs = computed(() => [{ id: "page", label: "Page" }, { id: "history", label: "History", count: page.value?.revisions.length }]);
const authorTone = (a: string) => (a === "user" ? "accent" : a === "remember" ? "success" : a === "system" ? "neutral" : "warning");
async function selectRevision(revId: number) {
  historyError.value = "";
  const list = page.value?.revisions ?? [];
  const idx = list.findIndex((r) => r.id === revId);
  const prevId = idx >= 0 ? list[idx + 1]?.id : undefined;
  try {
    const get = (r: number) => api<RevisionDetail>("GET", `pages/${encodeURIComponent(id.value)}/revisions/${r}`);
    const [rev, previous] = await Promise.all([get(revId), prevId !== undefined ? get(prevId) : undefined]);
    selected.value = { rev, ...(previous ? { previous } : {}) };
  } catch (e) {
    historyError.value = e instanceof Error ? e.message : String(e);
  }
}
const diff = computed(() => (selected.value ? lineDiff(selected.value.previous?.body ?? "", selected.value.rev.body) : []));
const fieldChanges = computed(() => {
  const s = selected.value;
  if (!s?.previous) return [];
  const out: string[] = [];
  if (s.previous.name !== s.rev.name) out.push(`name: ${s.previous.name} → ${s.rev.name}`);
  if (s.previous.type !== s.rev.type) out.push(`type: ${s.previous.type} → ${s.rev.type}`);
  if (s.previous.aliases.join(", ") !== s.rev.aliases.join(", ")) out.push(`aliases: ${s.previous.aliases.join(", ") || "none"} → ${s.rev.aliases.join(", ") || "none"}`);
  return out;
});
async function restoreSelected() {
  if (!selected.value || !page.value) return;
  historyError.value = "";
  try {
    await api("POST", `pages/${encodeURIComponent(id.value)}/restore`, { revisionId: selected.value.rev.id, baseRevision: page.value.revisionId });
    selected.value = null;
    await load();
    tab.value = "page";
  } catch (e) {
    historyError.value = e instanceof ApiError && e.code === "stale" ? "The page changed meanwhile; reopen the history and try again." : e instanceof Error ? e.message : String(e);
    await load();
  }
}

// Declared last: it runs immediately and resets the state above.
watch(id, () => {
  editing.value = false;
  conflict.value = null;
  confirmingDelete.value = false;
  selected.value = null;
  tab.value = "page";
  void load();
}, { immediate: true });
</script>

<template>
  <PageLayout eyebrow="Brain" :title="page?.name ?? 'Page'" :subtitle="subtitle">
    <template #actions>
      <Button variant="ghost" @click="router.push('/m/brain')"><Icon name="grid" />All pages</Button>
      <template v-if="page && !page.deletedAt && !editing">
        <Button @click="startEdit">Edit</Button>
        <Button v-if="!page.isProfile" variant="danger" @click="confirmingDelete = true">Delete</Button>
      </template>
    </template>
    <p v-if="error" class="text-f-error">{{ error }}</p>
    <p v-if="actionError" class="text-f-error">{{ actionError }}</p>

    <Card v-if="confirmingDelete && page">
      <div class="flex flex-wrap items-center gap-3">
        <span class="mr-auto text-sm text-f-text">Delete {{ page.name }}? It can be restored later from "Recently deleted".</span>
        <Button variant="ghost" @click="confirmingDelete = false">Cancel</Button>
        <Button variant="danger" @click="remove">Delete</Button>
      </div>
    </Card>

    <Card v-if="page?.deletedAt">
      <div class="flex flex-wrap items-center gap-3">
        <Badge tone="warning">deleted</Badge>
        <span class="mr-auto text-sm text-f-text-muted">Deleted {{ formatDateTime(page.deletedAt) }}. Friday no longer sees this page.</span>
        <Button variant="ghost" @click="undelete">Restore</Button>
      </div>
    </Card>

    <template v-if="page">
      <Tabs v-model="tab" :items="tabs" />

      <template v-if="tab === 'page'">
        <Card v-if="editing">
          <form class="flex flex-col gap-4" @submit.prevent="save">
            <div class="grid gap-4 md:grid-cols-2">
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-f-text-muted">Name</span>
                <input v-model="draft.name" :disabled="page.isProfile" class="surface-inset px-3 py-2 text-f-text outline-none focus:border-f-accent disabled:opacity-60" />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-f-text-muted">Type</span>
                <select v-model="draft.type" :disabled="page.isProfile" class="surface-inset px-3 py-2 text-f-text outline-none focus:border-f-accent disabled:opacity-60">
                  <option v-for="t in PAGE_TYPES" :key="t" :value="t">{{ t }}</option>
                </select>
              </label>
            </div>
            <label v-if="renamed" class="flex items-center gap-2 text-sm text-f-text">
              <input v-model="draft.keepOldName" type="checkbox" />Keep "{{ page.name }}" as an alias so links to it keep working
            </label>
            <Input v-model="draft.aliases" label="Aliases (comma-separated)" />
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-f-text-muted">Body (markdown; link pages with [[Name]])</span>
              <textarea v-model="draft.body" rows="18" spellcheck="true" class="surface-inset px-3 py-2 font-mono text-sm text-f-text outline-none focus:border-f-accent"></textarea>
            </label>
            <div v-if="conflict" class="flex flex-wrap items-center gap-3 rounded-lg border border-f-warning/60 p-3" role="alert">
              <span class="mr-auto text-sm text-f-text">Changed since you opened it (by <b>{{ conflict.author }}</b> at {{ formatDateTime(conflict.at) }}).</span>
              <Button variant="ghost" @click="discard">Discard my edits</Button>
              <Button variant="danger" @click="overwrite">Overwrite</Button>
            </div>
            <p v-if="saveError" class="text-sm text-f-error">{{ saveError }}</p>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" @click="editing = false; conflict = null">Cancel</Button>
              <Button type="submit" :disabled="!!conflict">Save</Button>
            </div>
          </form>
        </Card>

        <Card v-else>
          <!-- eslint-disable-next-line vue/no-v-html -- raw HTML disabled, see lib/markdown -->
          <div v-if="page.body.trim()" class="f-markdown brain-body" @click="onBodyClick" v-html="html" />
          <p v-else class="text-sm text-f-text-muted">Nothing here yet.</p>
        </Card>

        <Card v-if="!editing" title="Linked from">
          <ul v-if="page.backlinks.length" class="flex flex-col gap-2">
            <li v-for="(b, i) in page.backlinks" :key="`${b.pageId}-${i}`" class="text-sm">
              <button type="button" class="font-medium text-f-accent-bright hover:underline" @click="router.push(`/m/brain/p/${encodeURIComponent(b.pageId)}`)">{{ b.name }}</button>
              <span class="ml-2 text-f-text-muted">{{ b.line }}</span>
            </li>
          </ul>
          <p v-else class="text-sm text-f-text-muted">No other page links here.</p>
        </Card>
      </template>

      <template v-else>
        <p v-if="historyError" class="text-f-error">{{ historyError }}</p>
        <div class="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <Card title="Revisions">
            <ol class="flex flex-col divide-y divide-f-border-subtle">
              <li v-for="r in page.revisions" :key="r.id">
                <button type="button" :class="['flex w-full flex-col gap-1 py-2 text-left', selected?.rev.id === r.id && 'text-f-accent-bright']" @click="selectRevision(r.id)">
                  <span class="flex items-center gap-2">
                    <Badge :tone="authorTone(r.author)">{{ r.author }}</Badge>
                    <span class="text-sm text-f-text-muted">{{ formatDateTime(r.createdAt) }}</span>
                    <span v-if="r.id === page.revisionId" class="ml-auto text-xs text-f-text-muted">current</span>
                  </span>
                  <span v-if="r.note" class="text-sm text-f-text">{{ r.note }}</span>
                </button>
                <span v-if="r.sources.length" class="flex flex-wrap gap-1 pb-2">
                  <a v-for="s in r.sources" :key="s" :href="`/conversations?id=${encodeURIComponent(s)}`" class="text-xs" @click.prevent="router.push({ path: '/conversations', query: { id: s } })"><Chip>{{ s.slice(0, 8) }}</Chip></a>
                </span>
              </li>
            </ol>
          </Card>
          <Card v-if="selected" :title="`Revision ${selected.rev.id}`">
            <p class="text-sm text-f-text-muted">{{ selected.previous ? `Changes since revision ${selected.previous.id}` : "The first revision" }}</p>
            <ul v-if="fieldChanges.length" class="text-sm text-f-text">
              <li v-for="c in fieldChanges" :key="c">{{ c }}</li>
            </ul>
            <pre class="max-h-[32rem] overflow-auto rounded-lg bg-f-bg p-3 font-mono text-xs leading-5"><template v-for="(l, i) in diff" :key="i"><span :class="l.kind === 'add' ? 'text-f-success' : l.kind === 'del' ? 'text-f-error line-through opacity-80' : 'text-f-text-muted'">{{ l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  " }}{{ l.text }}
</span></template></pre>
            <div v-if="selected.rev.id !== page.revisionId && !page.deletedAt" class="flex justify-end">
              <Button @click="restoreSelected">Restore this version</Button>
            </div>
          </Card>
          <Card v-else><p class="text-sm text-f-text-muted">Select a revision to see what changed.</p></Card>
        </div>
      </template>
    </template>
  </PageLayout>
</template>

<style scoped>
.brain-body :deep(a.brain-dangling) {
  text-decoration-style: dashed;
  color: var(--color-f-text-muted);
}
</style>
