<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { PageLayout, Button, DataTable, StatusDot, Badge, Chip, Drawer, Icon, formatDateTime, formatTime, type Column } from "@friday/portal-ui";
import { api } from "../composables/useApi.js";

interface Summary extends Record<string, unknown> {
  id: string;
  channel: "voice" | "chat";
  device: string | null;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  endReason: string | null;
  quietAt: string | null;
  state: "active" | "quiet";
  entryCount: number;
  preview: string | null;
}
type Entry =
  | { seq: number; at: string; kind: "user"; input: "speech" | "text"; text: string }
  | { seq: number; at: string; kind: "assistant"; text: string; interrupted: boolean }
  | { seq: number; at: string; kind: "tool"; name: string; args: unknown; result?: unknown; truncated: boolean };
interface Conversation extends Summary {
  entries: Entry[];
}

const route = useRoute();
const router = useRouter();
const rows = ref<Summary[]>([]);
const next = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const columns: Column[] = [
  { key: "state", label: "", width: "3rem", align: "center" },
  { key: "startedAt", label: "Started" },
  { key: "channel", label: "Channel", hideBelow: "md" },
  { key: "device", label: "Device", hideBelow: "md" },
  { key: "preview", label: "First line" },
  { key: "entryCount", label: "Entries", align: "right", width: "6rem", hideBelow: "md" },
  { key: "duration", label: "Duration", align: "right", width: "7rem", hideBelow: "lg" },
];

async function load(more = false) {
  loading.value = true;
  try {
    const page = await api<{ conversations: Summary[]; next: string | null }>(`/api/conversations${more && next.value ? `?before=${encodeURIComponent(next.value)}` : ""}`);
    rows.value = more ? [...rows.value, ...page.conversations] : page.conversations;
    next.value = page.next;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/** `45 s`, `3 min 20 s`, `1 h 5 min`: from start to the end (or the last activity while active). */
function duration(c: Summary): string {
  const s = Math.max(0, Math.round((Date.parse(c.endedAt ?? c.lastActivityAt) - Date.parse(c.startedAt)) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ""}`;
}
const tone = (c: Summary) => (c.state === "active" ? "success" : "neutral");
const json = (v: unknown, truncated: boolean) => (truncated && typeof v === "string" ? `${v}… (truncated)` : JSON.stringify(v, null, 2));

// ---- drawer ---------------------------------------------------------------
const open = ref(false);
const selected = ref<Conversation | null>(null);
const confirming = ref(false);
const busy = ref(false);
const drawerError = ref<string | null>(null);

async function show(id: string) {
  confirming.value = false;
  drawerError.value = null;
  try {
    selected.value = await api<Conversation>(`/api/conversations/${encodeURIComponent(id)}`);
    open.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    if (route.query.id) router.replace({ query: { ...route.query, id: undefined } });
  }
}
const select = (c: Summary) => router.replace({ query: { ...route.query, id: c.id } });
watch(() => route.query.id, (id) => { if (typeof id === "string" && id !== selected.value?.id) void show(id); else if (!id) open.value = false; });
watch(open, (v) => { if (!v && route.query.id) router.replace({ query: { ...route.query, id: undefined } }); });
onMounted(() => {
  void load();
  if (typeof route.query.id === "string") void show(route.query.id);
});

async function remove() {
  const c = selected.value;
  if (!c) return;
  busy.value = true;
  try {
    await api(`/api/conversations/${encodeURIComponent(c.id)}`, { method: "DELETE" });
    rows.value = rows.value.filter((r) => r.id !== c.id);
    open.value = false;
    selected.value = null;
  } catch (e) {
    drawerError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
    confirming.value = false;
  }
}

const subtitle = computed(() => (selected.value ? `${formatDateTime(selected.value.startedAt)} · ${duration(selected.value)}` : ""));
</script>

<template>
  <PageLayout eyebrow="Assistant" title="Conversations" subtitle="What was said to Friday, newest first. Transcript text only, never audio.">
    <template #actions>
      <Button variant="ghost" :disabled="loading" @click="load()"><Icon name="refresh" />Refresh</Button>
    </template>
    <p v-if="error" class="text-f-error">{{ error }}</p>

    <DataTable :columns="columns" :rows="rows" row-key="id" clickable empty="No conversations yet" @row-click="select($event as Summary)">
      <template #cell-state="{ row }"><StatusDot :tone="tone(row as Summary)" :title="(row as Summary).state" /></template>
      <template #cell-startedAt="{ value }"><span class="text-f-text-muted whitespace-nowrap">{{ formatDateTime(value as string) }}</span></template>
      <template #cell-channel="{ value }"><Badge>{{ value }}</Badge></template>
      <template #cell-device="{ value }"><Chip v-if="value">{{ value }}</Chip><span v-else class="text-f-text-muted">–</span></template>
      <template #cell-preview="{ value }"><span class="line-clamp-1 break-all text-f-text-bright">{{ value ?? "" }}</span></template>
      <template #cell-duration="{ row }"><span class="text-f-text-muted whitespace-nowrap">{{ duration(row as Summary) }}</span></template>
    </DataTable>
    <div v-if="next" class="flex justify-center">
      <Button variant="ghost" :disabled="loading" @click="load(true)">{{ loading ? "Loading…" : "Load more" }}</Button>
    </div>

    <Drawer v-model:open="open" title="Conversation" :subtitle="subtitle">
      <template v-if="selected">
        <div class="flex flex-wrap items-center gap-2">
          <StatusDot :tone="tone(selected)" :label="selected.state" />
          <Badge>{{ selected.channel }}</Badge>
          <Chip v-if="selected.device">{{ selected.device }}</Chip>
        </div>
        <p v-if="selected.endReason" class="text-sm text-f-text-muted">Ended {{ formatDateTime(selected.endedAt) }}: <span class="font-mono text-f-text">{{ selected.endReason }}</span></p>
        <p v-if="drawerError" class="text-sm text-f-error">{{ drawerError }}</p>

        <ol class="flex flex-col gap-3">
          <li v-for="e in selected.entries" :key="e.seq" :class="['flex flex-col', e.kind === 'user' ? 'items-end' : 'items-start']">
            <template v-if="e.kind === 'tool'">
              <details class="w-full surface-inset text-sm">
                <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-f-text">
                  <Icon name="settings" :size="14" />
                  <span class="font-mono">{{ e.name }}</span>
                  <Badge v-if="e.truncated" tone="warning">truncated</Badge>
                  <Badge v-if="!('result' in e)" tone="warning">no result</Badge>
                  <span class="ml-auto text-xs text-f-text-muted">{{ formatTime(e.at) }}</span>
                </summary>
                <div class="flex flex-col gap-2 px-3 pb-3">
                  <div class="text-xs uppercase tracking-wide text-f-text-muted">Arguments</div>
                  <pre class="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-f-text">{{ json(e.args, e.truncated) }}</pre>
                  <template v-if="'result' in e">
                    <div class="text-xs uppercase tracking-wide text-f-text-muted">Result</div>
                    <pre class="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-f-text">{{ json(e.result, e.truncated) }}</pre>
                  </template>
                  <p v-else class="text-xs text-f-text-muted">The session closed before the tool finished.</p>
                </div>
              </details>
            </template>
            <template v-else>
              <div :class="['max-w-[85%] rounded-2xl px-3 py-2 text-sm', e.kind === 'user' ? 'bg-f-accent text-white rounded-br-sm' : 'bg-f-surface-elevated text-f-text-bright rounded-bl-sm']">{{ e.text }}</div>
              <div class="mt-1 flex items-center gap-1.5 text-xs text-f-text-muted">
                <template v-if="e.kind === 'user'">
                  <span :title="e.input === 'text' ? 'typed' : 'spoken'" class="inline-flex items-center gap-1"><Icon :name="e.input === 'text' ? 'keyboard' : 'mic'" :size="12" />{{ e.input === "text" ? "typed" : "spoken" }}</span>
                </template>
                <Badge v-else-if="e.interrupted" tone="warning">interrupted</Badge>
                <span>{{ formatTime(e.at) }}</span>
              </div>
            </template>
          </li>
        </ol>
        <p v-if="!selected.entries.length" class="text-sm text-f-text-muted">No entries.</p>
      </template>
      <template #footer>
        <template v-if="confirming">
          <span class="mr-auto text-sm text-f-text">Delete this conversation?</span>
          <Button variant="ghost" :disabled="busy" @click="confirming = false">Cancel</Button>
          <Button variant="danger" :disabled="busy" @click="remove">Delete</Button>
        </template>
        <Button v-else variant="danger" :disabled="busy || !selected" @click="confirming = true">Delete</Button>
      </template>
    </Drawer>
  </PageLayout>
</template>
