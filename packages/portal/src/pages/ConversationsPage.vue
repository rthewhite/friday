<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { PageLayout, Button, DataTable, StatusDot, Badge, Chip, Drawer, Icon, formatDateTime, type Column } from "@friday/portal-ui";
import { api } from "../composables/useApi.js";
import type { Conversation, Summary } from "../lib/conversations.js";
import TranscriptEntry from "../components/TranscriptEntry.vue";

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
          <TranscriptEntry v-for="e in selected.entries" :key="e.seq" :entry="e" :markdown="selected.channel === 'chat'" />
        </ol>
        <p v-if="!selected.entries.length" class="text-sm text-f-text-muted">No entries.</p>
      </template>
      <template #footer>
        <template v-if="confirming">
          <span class="mr-auto text-sm text-f-text">Delete this conversation?</span>
          <Button variant="ghost" :disabled="busy" @click="confirming = false">Cancel</Button>
          <Button variant="danger" :disabled="busy" @click="remove">Delete</Button>
        </template>
        <template v-else>
          <Button v-if="selected?.channel === 'chat'" class="mr-auto" @click="router.push(`/chat/${encodeURIComponent(selected.id)}`)"><Icon name="message" />Open in Chat</Button>
          <Button variant="danger" :disabled="busy || !selected" @click="confirming = true">Delete</Button>
        </template>
      </template>
    </Drawer>
  </PageLayout>
</template>
