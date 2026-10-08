<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { PageLayout, Button, DataTable, StatusDot, Badge, Icon, formatDateTime, type Column } from "@friday/portal-ui";
import { api } from "../../composables/useApi.js";
import { splitAlerts, stateTone, targetText, timeLeft, type AlertRecord } from "../../lib/alerts.js";

const alerts = ref<AlertRecord[]>([]);
const error = ref<string | null>(null);
const loading = ref(false);
const cancelling = ref<string | null>(null);
const now = ref(Date.now());

const lists = computed(() => splitAlerts(alerts.value));

const activeColumns: Column[] = [
  { key: "status", label: "", width: "3rem", align: "center" },
  { key: "label", label: "Alert" },
  { key: "target", label: "Device" },
  { key: "dueAt", label: "Due", hideBelow: "md" },
  { key: "left", label: "Time left" },
  { key: "actions", label: "", align: "right" },
];
const finishedColumns: Column[] = [
  { key: "status", label: "", width: "3rem", align: "center" },
  { key: "label", label: "Alert" },
  { key: "target", label: "Device" },
  { key: "dueAt", label: "Due", hideBelow: "md" },
  { key: "state", label: "Outcome" },
];

async function load() {
  loading.value = true;
  try { alerts.value = (await api<{ alerts: AlertRecord[] }>("/api/alerts")).alerts; error.value = null; }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { loading.value = false; }
}

async function cancel(a: AlertRecord) {
  cancelling.value = a.id;
  try { await api(`/api/alerts/${a.id}`, { method: "DELETE" }); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { cancelling.value = null; await load(); }
}

// The time left ticks every second; the list itself reloads every 15 s, so a timer set by voice shows up on its own.
let tick: ReturnType<typeof setInterval> | undefined;
let poll: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  tick = setInterval(() => (now.value = Date.now()), 1000);
  poll = setInterval(() => void load(), 15_000);
});
onBeforeUnmount(() => { clearInterval(tick); clearInterval(poll); });

const row = (r: unknown) => r as AlertRecord;
</script>

<template>
  <PageLayout eyebrow="System" title="Alerts" subtitle="Timers Friday rings on your voice devices, and what became of them.">
    <template #actions>
      <Button variant="ghost" :disabled="loading" @click="load"><Icon name="refresh" />Refresh</Button>
    </template>
    <p v-if="error" class="text-f-error">{{ error }}</p>

    <section class="flex flex-col gap-2">
      <h2 class="text-sm font-medium text-f-text-bright">Running</h2>
      <DataTable :columns="activeColumns" :rows="lists.active" row-key="id" empty="No timers running">
        <template #cell-status="{ row: r }"><StatusDot :tone="stateTone[row(r).state]" :title="row(r).state" /></template>
        <template #cell-label="{ row: r }">
          <span class="font-medium text-f-text-bright">{{ row(r).label }}</span>
          <Badge class="ml-2">{{ row(r).kind }}</Badge>
        </template>
        <template #cell-target="{ row: r }"><span :title="row(r).target.id">{{ targetText(row(r)) }}</span></template>
        <template #cell-dueAt="{ value }"><span class="text-f-text-muted whitespace-nowrap">{{ formatDateTime(value as string) }}</span></template>
        <template #cell-left="{ row: r }">
          <span :class="['whitespace-nowrap', row(r).state === 'ringing' ? 'text-f-accent-bright' : 'text-f-text']">
            {{ row(r).state === "ringing" ? `ringing${row(r).rings ? ` (${row(r).rings} unanswered)` : ""}` : timeLeft(row(r).dueAt, now) }}
          </span>
        </template>
        <template #cell-actions="{ row: r }">
          <Button variant="ghost" :disabled="cancelling === row(r).id" @click="cancel(row(r))">Cancel</Button>
        </template>
      </DataTable>
    </section>

    <section class="flex flex-col gap-2">
      <h2 class="text-sm font-medium text-f-text-bright">Finished</h2>
      <DataTable :columns="finishedColumns" :rows="lists.finished" row-key="id" empty="Nothing has rung yet">
        <template #cell-status="{ row: r }"><StatusDot :tone="stateTone[row(r).state]" :title="row(r).state" /></template>
        <template #cell-label="{ row: r }">
          <span class="font-medium text-f-text-bright">{{ row(r).label }}</span>
          <Badge class="ml-2">{{ row(r).kind }}</Badge>
        </template>
        <template #cell-target="{ row: r }"><span :title="row(r).target.id">{{ targetText(row(r)) }}</span></template>
        <template #cell-dueAt="{ value }"><span class="text-f-text-muted whitespace-nowrap">{{ formatDateTime(value as string) }}</span></template>
        <template #cell-state="{ row: r }">
          <span :class="row(r).state === 'missed' ? 'text-f-error font-medium' : 'text-f-text-muted'">{{ row(r).state }}</span>
          <span v-if="row(r).finishedAt" class="text-f-text-muted text-xs ml-2 whitespace-nowrap">{{ formatDateTime(row(r).finishedAt) }}</span>
        </template>
      </DataTable>
    </section>
  </PageLayout>
</template>
