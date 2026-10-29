<script setup lang="ts">
/** Agents: the list at /agents, and the editor with run history at /agents/new and /agents/:name (see the agents spec). */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { PageLayout, Button, DataTable, StatusDot, Badge, Icon, formatDateTime, type Column } from "@friday/portal-ui";
import { api } from "../composables/useApi.js";
import { agentStatus, describeSchedule, type Agent } from "../lib/agents.js";
import AgentEditor from "./AgentEditor.vue";

const route = useRoute();
const router = useRouter();
const agents = ref<Agent[]>([]);
const error = ref<string | null>(null);
const loading = ref(false);

/** `/agents/:name`: the editor; `new` creates one. */
const name = computed(() => (typeof route.params.name === "string" ? route.params.name : null));

const columns: Column[] = [
  { key: "status", label: "", width: "3rem", align: "center" },
  { key: "name", label: "Agent" },
  { key: "enabled", label: "", width: "6rem", hideBelow: "md" },
  { key: "schedule", label: "Schedule", hideBelow: "md" },
  { key: "nextRunAt", label: "Next run", hideBelow: "lg" },
  { key: "lastRun", label: "Last run" },
  { key: "pendingActions", label: "Approvals", width: "7rem" },
];

async function load() {
  loading.value = true;
  try { agents.value = (await api<{ agents: Agent[] }>("/api/agents")).agents; error.value = null; }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { loading.value = false; }
}

// Poll while an agent runs, so its row settles on its own.
const anyRunning = computed(() => agents.value.some((a) => a.running));
let poll: ReturnType<typeof setInterval> | undefined;
watch(anyRunning, (on) => {
  if (on && !poll && !name.value) poll = setInterval(() => void load(), 3000);
  if (!on && poll) { clearInterval(poll); poll = undefined; }
});
watch(name, (n) => { if (!n) void load(); });
onMounted(load);
onBeforeUnmount(() => { if (poll) clearInterval(poll); });

const when = (s: string | null | undefined, fallback = "") => formatDateTime(s, fallback);
</script>

<template>
  <AgentEditor v-if="name" :key="name" :name="name" @saved="load" @deleted="router.push('/agents')" />
  <PageLayout v-else eyebrow="Assistant" title="Agents" subtitle="Tasks Friday runs for you, unattended, over the tools you allow, on a schedule or when you ask. Only you see your agents.">
    <template #actions>
      <Button variant="ghost" :disabled="loading" @click="load"><Icon name="refresh" />Refresh</Button>
      <Button @click="router.push('/agents/new')"><Icon name="plus" />New agent</Button>
    </template>
    <p v-if="error" class="text-f-error">{{ error }}</p>

    <DataTable :columns="columns" :rows="agents" row-key="name" clickable empty="No agents yet" @row-click="router.push(`/agents/${encodeURIComponent(($event as Agent).name)}`)">
      <template #cell-status="{ row }"><StatusDot :tone="agentStatus(row as Agent).tone" :title="agentStatus(row as Agent).label" /></template>
      <template #cell-name="{ row }">
        <div class="font-mono text-f-text-bright">{{ (row as Agent).name }}</div>
        <div class="text-xs text-f-text-muted">{{ (row as Agent).description }}</div>
      </template>
      <!-- Always a span: an empty slot would make the table show the raw value. -->
      <template #cell-enabled="{ row }">
        <span><Badge v-if="!(row as Agent).enabled">disabled</Badge><Badge v-else-if="(row as Agent).startable" tone="accent">voice</Badge></span>
      </template>
      <template #cell-schedule="{ row }"><span class="whitespace-nowrap">{{ describeSchedule((row as Agent).schedule) }}</span></template>
      <template #cell-nextRunAt="{ value }"><span class="text-f-text-muted whitespace-nowrap">{{ when(value as string | null, "none") }}</span></template>
      <template #cell-lastRun="{ row }">
        <span v-if="(row as Agent).running" class="text-f-accent-bright whitespace-nowrap">running since {{ when((row as Agent).running!.startedAt) }}</span>
        <span v-else-if="(row as Agent).lastRun" class="text-f-text-muted whitespace-nowrap">{{ when((row as Agent).lastRun!.startedAt) }} · {{ agentStatus(row as Agent).label }}</span>
        <span v-else class="text-f-text-muted">never</span>
      </template>
      <template #cell-pendingActions="{ value }">
        <span><Badge v-if="(value as number) > 0" tone="accent">{{ value }} pending</Badge></span>
      </template>
    </DataTable>
  </PageLayout>
</template>
