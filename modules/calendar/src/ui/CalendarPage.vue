<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { Badge, Button, Card, DataTable, Icon, PageLayout, StatusDot, Tabs, formatDateTime, type Column } from "@friday/portal-ui";
import { ApiError, actionLabel, api, changeDetail, settingsPatch, type CalendarRow, type ChangeRow, type Status } from "./lib/calendar.js";

const tab = ref("overview");
const status = ref<Status | null>(null);
const agenda = ref<{ text: string; fetchedAt: string | null } | null>(null);
const changes = ref<ChangeRow[] | null>(null);
const error = ref("");
const notice = ref("");
const busy = ref(false);
const rowError = ref<Record<number, string>>({});

const columns: Column[] = [
  { key: "at", label: "When" },
  { key: "source", label: "From", hideBelow: "md" },
  { key: "action", label: "What" },
  { key: "detail", label: "Event" },
];

async function run(fn: () => Promise<void>) {
  error.value = "";
  notice.value = "";
  busy.value = true;
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function loadOverview() {
  status.value = await api<Status>("GET", "status");
  agenda.value = await api<{ text: string; fetchedAt: string | null }>("GET", "agenda");
}

async function loadChanges() {
  changes.value = (await api<{ changes: ChangeRow[] }>("GET", "changes?limit=100")).changes;
}

const load = () => run(() => (tab.value === "changes" ? loadChanges() : loadOverview()));
onMounted(load);
watch(tab, load);

function refresh() {
  return run(async () => {
    status.value = await api<Status>("POST", "refresh");
    agenda.value = await api<{ text: string; fetchedAt: string | null }>("GET", "agenda");
  });
}

function save(row: CalendarRow, change: { use?: boolean; inAgenda?: boolean; default?: true }) {
  return run(async () => {
    // The route refreshes the agenda before it answers, so the preview below is current.
    status.value = await api<Status>("PUT", "settings", settingsPatch(row, change));
    agenda.value = await api<{ text: string; fetchedAt: string | null }>("GET", "agenda");
  });
}

function undo(c: ChangeRow) {
  rowError.value = { ...rowError.value, [c.id]: "" };
  return run(async () => {
    try {
      const r = await api<{ say: string }>("POST", `changes/${c.id}/undo`);
      await loadChanges();
      notice.value = r.say;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) rowError.value = { ...rowError.value, [c.id]: e.message };
      else throw e;
    }
  });
}

const rows = () => (changes.value ?? []).map((c) => ({ ...c, detail: changeDetail(c) }));
</script>

<template>
  <PageLayout eyebrow="Modules" title="Calendar" subtitle="What Friday sees of your iCloud calendar, and what it changed">
    <template #actions>
      <Button variant="ghost" :disabled="busy" @click="tab === 'overview' ? refresh() : load()"><Icon name="refresh" />Refresh</Button>
    </template>
    <p v-if="error" class="text-f-error">{{ error }}</p>
    <p v-if="notice" class="text-f-success">{{ notice }}</p>

    <Tabs v-model="tab" :items="[{ id: 'overview', label: 'Overview' }, { id: 'changes', label: 'Changes' }]" />

    <template v-if="tab === 'overview' && status">
      <Card title="Connection">
        <div class="flex flex-wrap items-center gap-3 text-sm">
          <StatusDot :tone="status.connected ? 'success' : 'error'" :label="status.connected ? 'Connected' : 'Not connected'" />
          <span class="text-f-text-muted">{{ status.username ?? "no ICLOUD_USERNAME" }}</span>
          <span v-if="status.checkedAt" class="text-f-text-muted">checked {{ formatDateTime(status.checkedAt) }}</span>
        </div>
        <p v-if="status.error" class="text-sm text-f-error">{{ status.error }}</p>
      </Card>

      <Card title="Calendars">
        <p v-if="!status.calendars.length" class="text-sm text-f-text-muted">No calendars found yet.</p>
        <ul v-else class="flex flex-col divide-y divide-f-border-subtle">
          <li v-for="c in status.calendars" :key="c.id" class="flex flex-wrap items-center gap-x-6 gap-y-2 py-3 text-sm">
            <span class="flex min-w-48 items-center gap-2">
              <span class="inline-block h-3 w-3 shrink-0 rounded-full" :style="{ background: c.color ?? 'var(--color-f-text-muted)' }" aria-hidden="true" />
              <span class="font-medium text-f-text-bright">{{ c.name }}</span>
              <Badge v-if="!c.writable">read-only</Badge>
            </span>
            <label class="flex items-center gap-2">
              <input type="checkbox" :checked="c.use" :disabled="busy" @change="save(c, { use: ($event.target as HTMLInputElement).checked })" />
              Friday uses it
            </label>
            <label class="flex items-center gap-2">
              <input type="checkbox" :checked="c.inAgenda" :disabled="busy || !c.use" @change="save(c, { inAgenda: ($event.target as HTMLInputElement).checked })" />
              In the agenda
            </label>
            <label class="flex items-center gap-2" :title="c.writable ? '' : 'Read-only calendars can not take new events'">
              <input type="radio" name="calendar-default" :checked="c.default" :disabled="busy || !c.writable || !c.use" @change="save(c, { default: true })" />
              New events go here
            </label>
          </li>
        </ul>
      </Card>

      <Card title="In Friday's prompt right now">
        <pre class="surface-inset whitespace-pre-wrap p-3 text-sm text-f-text">{{ agenda?.text }}</pre>
        <p v-if="agenda?.fetchedAt" class="text-xs text-f-text-muted">Fetched {{ formatDateTime(agenda.fetchedAt) }}</p>
      </Card>
    </template>

    <template v-if="tab === 'changes'">
      <DataTable :columns="columns" :rows="rows()" row-key="id" empty="Friday hasn't changed anything yet">
        <template #cell-at="{ value }"><span class="whitespace-nowrap text-f-text-muted">{{ formatDateTime(value as string) }}</span></template>
        <template #cell-source="{ value }"><Badge>{{ value }}</Badge></template>
        <template #cell-action="{ row }">
          <span class="whitespace-nowrap">{{ actionLabel(row as ChangeRow) }}</span>
          <Badge v-if="(row as ChangeRow).undone" tone="warning" class="ml-2">undone</Badge>
        </template>
        <template #cell-detail="{ row }">
          <span class="text-f-text">{{ (row as ChangeRow & { detail: string }).detail }}</span>
          <p v-if="rowError[(row as ChangeRow).id]" class="text-sm text-f-error">{{ rowError[(row as ChangeRow).id] }}</p>
        </template>
        <template #actions="{ row }">
          <Button v-if="(row as ChangeRow).undoable" variant="ghost" :disabled="busy" @click="undo(row as ChangeRow)">Undo</Button>
        </template>
      </DataTable>
    </template>
  </PageLayout>
</template>
