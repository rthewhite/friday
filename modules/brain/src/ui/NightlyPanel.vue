<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { Badge, Button, Card, Chip, DataTable, formatDateTime, type Column } from "@friday/portal-ui";
import { lineDiff } from "./lib/diff.js";
import { ApiError, api, type RunPageView, type RunSummary } from "./lib/pages.js";

const router = useRouter();
const runs = ref<RunSummary[] | null>(null);
const error = ref("");
const selected = ref<{ run: RunSummary; pages: RunPageView[] } | null>(null);
const notice = ref("");
const stale = ref<string | null>(null);

const columns: Column[] = [
  { key: "startedAt", label: "Started" },
  { key: "trigger", label: "Trigger", hideBelow: "md" },
  { key: "outcome", label: "Outcome" },
  { key: "summary", label: "Summary" },
];
const tone = (o?: string) => (o === "ok" ? "success" : o === "partial" ? "warning" : o === "failed" ? "error" : "neutral");

async function load() {
  error.value = "";
  try {
    runs.value = (await api<{ runs: RunSummary[] }>("GET", "runs?limit=14")).runs;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(load);

async function open(id: number) {
  notice.value = "";
  stale.value = null;
  try {
    selected.value = await api<{ run: RunSummary; pages: RunPageView[] }>("GET", `runs/${id}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

const diffOf = (p: RunPageView) => lineDiff(p.before?.body ?? "", p.after.body);
const visible = computed(() => (selected.value?.pages ?? []).filter((p) => !p.mergedInto));
const nameOf = (id: string) => selected.value?.pages.find((p) => p.pageId === id)?.name ?? id;

async function revert(p: RunPageView) {
  if (!selected.value) return;
  notice.value = "";
  stale.value = null;
  try {
    const { reverted } = await api<{ reverted: string[] }>("POST", `runs/${selected.value.run.id}/pages/${encodeURIComponent(p.pageId)}/revert`, { base: p.currentRevisionId });
    // Reload the run first: open() clears the notice.
    await open(selected.value.run.id);
    notice.value = `Reverted ${reverted.join(" and ")}.`;
  } catch (e) {
    if (e instanceof ApiError && e.code === "stale") stale.value = p.pageId;
    else error.value = e instanceof Error ? e.message : String(e);
  }
}
const openPage = (id: string) => router.push(`/m/brain/p/${encodeURIComponent(id)}`);
</script>

<template>
  <div class="flex flex-col gap-4">
    <p v-if="error" class="text-f-error">{{ error }}</p>
    <Card v-if="runs && !runs.length">
      <p class="text-sm text-f-text">
        No nightly runs yet. Every night (03:00 by default, <code class="font-mono">BRAIN_NIGHTLY_CRON</code>) Friday reads the conversations that finished,
        notes lasting facts, and tidies the pages. Everything it changes shows up here and can be reverted.
      </p>
      <RouterLink to="/settings/jobs" class="text-sm text-f-accent-bright hover:underline">Run it now from the Jobs page</RouterLink>
    </Card>
    <DataTable v-else-if="runs" :columns="columns" :rows="runs as unknown as Record<string, unknown>[]" row-key="id" clickable empty="No runs" @row-click="open(($event as unknown as RunSummary).id)">
      <template #cell-startedAt="{ value }"><span class="whitespace-nowrap text-f-text-muted">{{ formatDateTime(value as string) }}</span></template>
      <template #cell-trigger="{ value }"><Badge>{{ value }}</Badge></template>
      <template #cell-outcome="{ value }"><Badge :tone="tone(value as string)">{{ value ?? "running" }}</Badge></template>
      <template #cell-summary="{ row }">
        <span class="text-f-text">{{ (row as unknown as RunSummary).summary }}</span>
        <span v-if="(row as unknown as RunSummary).error" class="block text-xs text-f-warning">{{ (row as unknown as RunSummary).error }}</span>
      </template>
    </DataTable>

    <template v-if="selected">
      <p class="text-sm text-f-text-muted">Run {{ selected.run.id }}, {{ formatDateTime(selected.run.startedAt) }}: {{ selected.run.summary }}</p>
      <p v-if="notice" class="text-f-success">{{ notice }}</p>
      <p v-if="!visible.length" class="text-sm text-f-text-muted">This run didn't change any page.</p>
      <Card v-for="p in visible" :key="p.pageId">
        <template #header>
          <div class="flex w-full flex-wrap items-center gap-2">
            <button type="button" class="font-semibold text-f-text-bright hover:underline" @click="openPage(p.pageId)">{{ p.name }}</button>
            <Badge v-if="!p.before" tone="accent">created</Badge>
            <Badge v-if="p.mergedFrom" tone="accent">merged {{ nameOf(p.mergedFrom) }} into it</Badge>
            <Badge v-for="a in p.authors" :key="a">{{ a }}</Badge>
            <Badge v-if="p.changedSince" tone="warning">changed since</Badge>
            <span class="ml-auto">
              <Button variant="ghost" :disabled="p.changedSince" @click="revert(p)">Revert</Button>
            </span>
          </div>
        </template>
        <p v-if="stale === p.pageId || p.changedSince" class="text-sm text-f-warning">
          {{ p.name }} was also changed by someone else during or after this run, so reverting here would undo that too.
          <button type="button" class="text-f-accent-bright hover:underline" @click="openPage(p.pageId)">Open the page</button> to restore an older version from its history.
        </p>
        <pre class="max-h-96 overflow-auto rounded-lg bg-f-bg p-3 font-mono text-xs leading-5"><template v-for="(l, i) in diffOf(p)" :key="i"><span :class="l.kind === 'add' ? 'text-f-success' : l.kind === 'del' ? 'text-f-error line-through opacity-80' : 'text-f-text-muted'">{{ l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  " }}{{ l.text }}
</span></template></pre>
        <div v-if="p.dropped.length" class="text-sm">
          <p class="text-f-text-muted">Dropped on purpose:</p>
          <ul class="list-disc pl-5">
            <li v-for="(d, i) in p.dropped" :key="i"><span class="text-f-text">{{ d.line }}</span> <span class="text-f-text-muted">— {{ d.reason }}</span></li>
          </ul>
        </div>
        <div v-if="p.sources.length" class="flex flex-wrap items-center gap-1 text-sm">
          <span class="text-f-text-muted">From:</span>
          <template v-for="s in p.sources" :key="s.id">
            <a v-if="s.exists" :href="`/conversations?id=${encodeURIComponent(s.id)}`" @click.prevent="router.push({ path: '/conversations', query: { id: s.id } })"><Chip>{{ s.id.slice(0, 8) }}</Chip></a>
            <span v-else :title="`${s.id} was deleted (retention)`"><Chip>{{ s.id.slice(0, 8) }} (gone)</Chip></span>
          </template>
        </div>
      </Card>
    </template>
  </div>
</template>
