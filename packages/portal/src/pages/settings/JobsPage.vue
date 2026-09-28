<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { PageLayout, Button, DataTable, StatusDot, Badge, Chip, Drawer, Icon, formatDateTime, type Column } from "@friday/portal-ui";
import { api } from "../../composables/useApi.js";

type Outcome = "ok" | "failed" | "skipped" | "cancelled" | "running";

interface JobRun {
  id: string;
  jobId: string;
  trigger: "schedule" | "catch-up" | "manual" | "module";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: Outcome;
  summary?: string;
  error?: string;
}

interface Job extends Record<string, unknown> {
  id: string;
  owner: string;
  name: string;
  description?: string;
  schedule: { cron: string; timezone: string } | { everyMs: number };
  nextRunAt: string | null;
  running: boolean;
  runningSince?: string;
  lastRun: JobRun | null;
}

const jobs = ref<Job[]>([]);
const error = ref<string | null>(null);
const loading = ref(false);
const open = ref(false);
const selectedId = ref<string | null>(null);
const runs = ref<JobRun[]>([]);
const starting = ref(false);

const selected = computed(() => jobs.value.find((j) => j.id === selectedId.value) ?? null);

const columns: Column[] = [
  { key: "status", label: "", width: "3rem", align: "center" },
  { key: "name", label: "Job" },
  { key: "owner", label: "Owner", hideBelow: "md" },
  { key: "schedule", label: "Schedule", hideBelow: "md" },
  { key: "nextRunAt", label: "Next run", hideBelow: "lg" },
  { key: "lastRun", label: "Last run" },
];

const tones: Record<Outcome, "success" | "error" | "warning" | "neutral" | "accent"> = { ok: "success", failed: "error", cancelled: "warning", skipped: "neutral", running: "accent" };
const status = (j: Job): Outcome | "never run" => (j.running ? "running" : j.lastRun?.outcome ?? "never run");
const statusTone = (j: Job) => (j.running ? "accent" : j.lastRun ? tones[j.lastRun.outcome] : "neutral");

function every(ms: number): string {
  const units: [number, string][] = [[86_400_000, "d"], [3_600_000, "h"], [60_000, "min"], [1000, "s"]];
  for (const [size, unit] of units) if (ms % size === 0) return `every ${ms / size} ${unit}`;
  return `every ${(ms / 1000).toFixed(1)} s`;
}
const schedule = (j: Job) => ("cron" in j.schedule ? `${j.schedule.cron} (${j.schedule.timezone})` : every(j.schedule.everyMs));

function duration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

async function loadRuns() {
  if (!selectedId.value) return;
  const [owner, name] = selectedId.value.split("/");
  try { runs.value = await api<JobRun[]>(`/api/jobs/${owner}/${name}/runs`); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}

async function load() {
  loading.value = true;
  try { jobs.value = await api<Job[]>("/api/jobs"); error.value = null; }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { loading.value = false; }
  if (open.value) await loadRuns();
}

function show(j: Job) { selectedId.value = j.id; runs.value = []; open.value = true; void loadRuns(); }

async function runNow(j: Job) {
  starting.value = true;
  try { await api(`/api/jobs/${j.owner}/${j.name}/run`, { method: "POST" }); await load(); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); await load(); }
  finally { starting.value = false; }
}

// Poll while any job runs, so rows and the open history settle on their own.
const anyRunning = computed(() => jobs.value.some((j) => j.running));
let poll: ReturnType<typeof setInterval> | undefined;
watch(anyRunning, (on) => {
  if (on && !poll) poll = setInterval(() => void load(), 3000);
  if (!on && poll) { clearInterval(poll); poll = undefined; }
});
onMounted(load);
onBeforeUnmount(() => { if (poll) clearInterval(poll); });

const when = (s: string | null | undefined, fallback = "") => formatDateTime(s, fallback);
</script>

<template>
  <PageLayout eyebrow="System" title="Jobs" subtitle="Background work Friday runs on a schedule, and what happened when it ran.">
    <template #actions>
      <Button variant="ghost" :disabled="loading" @click="load"><Icon name="refresh" />Refresh</Button>
    </template>
    <p v-if="error" class="text-f-error">{{ error }}</p>

    <DataTable :columns="columns" :rows="jobs" row-key="id" clickable empty="No jobs registered" @row-click="show($event as Job)">
      <template #cell-status="{ row }"><StatusDot :tone="statusTone(row as Job)" :title="status(row as Job)" /></template>
      <template #cell-name="{ row }">
        <div class="font-medium text-f-text-bright">{{ (row as Job).name }}</div>
        <div v-if="(row as Job).description" class="text-xs text-f-text-muted">{{ (row as Job).description }}</div>
      </template>
      <template #cell-owner="{ value }"><Chip>{{ value }}</Chip></template>
      <template #cell-schedule="{ row }"><span class="font-mono text-xs whitespace-nowrap">{{ schedule(row as Job) }}</span></template>
      <template #cell-nextRunAt="{ value }"><span class="text-f-text-muted whitespace-nowrap">{{ when(value as string | null, "none") }}</span></template>
      <template #cell-lastRun="{ row }">
        <span v-if="(row as Job).running" class="text-f-accent-bright whitespace-nowrap">running since {{ when((row as Job).runningSince) }}</span>
        <span v-else-if="(row as Job).lastRun" class="text-f-text-muted whitespace-nowrap">{{ when((row as Job).lastRun!.startedAt) }} · {{ duration((row as Job).lastRun!.durationMs) }}</span>
        <span v-else class="text-f-text-muted">never</span>
      </template>
    </DataTable>

    <Drawer v-model:open="open" :title="selected?.id ?? ''" :subtitle="selected?.description">
      <template v-if="selected">
        <div class="flex flex-wrap items-center gap-2">
          <StatusDot :tone="statusTone(selected)" :label="status(selected)" />
          <Chip>{{ selected.owner }}</Chip>
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt class="text-f-text-muted">Schedule</dt><dd class="font-mono text-xs self-center">{{ schedule(selected) }}</dd>
          <dt class="text-f-text-muted">Next run</dt><dd>{{ when(selected.nextRunAt, "none") }}</dd>
          <template v-if="selected.running"><dt class="text-f-text-muted">Running since</dt><dd>{{ when(selected.runningSince) }}</dd></template>
        </dl>
        <div>
          <h3 class="text-sm font-medium text-f-text-bright mb-2">History ({{ runs.length }})</h3>
          <p v-if="!runs.length" class="text-sm text-f-text-muted">No runs yet</p>
          <ul v-else class="flex flex-col gap-2">
            <li v-for="r in runs" :key="r.id" class="surface-inset p-3 flex flex-col gap-1 text-sm">
              <div class="flex flex-wrap items-center gap-2">
                <StatusDot :tone="tones[r.outcome]" :label="r.outcome" />
                <Badge>{{ r.trigger }}</Badge>
                <span class="text-f-text-muted whitespace-nowrap">{{ when(r.startedAt) }}</span>
                <span v-if="r.durationMs !== null && r.outcome !== 'skipped'" class="text-f-text-muted ml-auto">{{ duration(r.durationMs) }}</span>
              </div>
              <p v-if="r.error" class="text-f-error font-mono text-xs break-words">{{ r.error }}</p>
              <p v-else-if="r.summary" class="text-f-text">{{ r.summary }}</p>
            </li>
          </ul>
        </div>
      </template>
      <template #footer>
        <Button v-if="selected" :disabled="selected.running || starting" @click="runNow(selected)"><Icon name="play" />{{ selected.running ? "Running…" : "Run now" }}</Button>
      </template>
    </Drawer>
  </PageLayout>
</template>
