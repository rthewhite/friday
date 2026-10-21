<script setup lang="ts">
/** One agent: its definition (`name` is `new` for a new one), Run now, its runs, and a run's parked actions. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { PageLayout, Button, Card, Input, DataTable, StatusDot, Badge, Chip, Drawer, Icon, formatDateTime, type Column } from "@friday/portal-ui";
import { api } from "../composables/useApi.js";
import {
  BUDGETS, actionTone, agentStatus, describeSchedule, matching, outcomeTone, runDuration,
  type Agent, type AgentAction, type AgentRun, type AgentTool, type Budgets, type ToolEntry,
} from "../lib/agents.js";

const props = defineProps<{ name: string }>();
const emit = defineEmits<{ saved: []; deleted: [] }>();
const router = useRouter();

const adding = computed(() => props.name === "new");
const agent = ref<Agent | null>(null);
const tools = ref<AgentTool[]>([]);
const runs = ref<AgentRun[]>([]);
const error = ref<string | null>(null);
const notice = ref<string | null>(typeof history.state?.notice === "string" ? history.state.notice : null);
const busy = ref<null | "save" | "run" | "delete">(null);
const confirmDelete = ref(false);
const request = ref("");
const showTools = ref(false);

const blank = () => ({
  name: "",
  description: "",
  instructions: "",
  schedule: "",
  enabled: true,
  startable: false,
  tools: [] as ToolEntry[],
  budgets: Object.fromEntries(Object.entries(BUDGETS).map(([k, b]) => [k, b.default])) as unknown as Budgets,
});
const draft = ref(blank());

function fill(a: Agent) {
  agent.value = a;
  draft.value = {
    name: a.name,
    description: a.description,
    instructions: a.instructions,
    schedule: a.schedule ?? "",
    enabled: a.enabled,
    startable: a.startable,
    tools: a.tools.map((t) => ({ ...t })),
    budgets: { ...a.budgets },
  };
}

const toolNames = computed(() => tools.value.map((t) => t.name));
const matchesOf = (pattern: string) => matching(pattern, toolNames.value);

async function load() {
  try {
    tools.value = (await api<{ tools: AgentTool[] }>("/api/agents/tools")).tools;
    if (!adding.value) {
      const a = await api<Agent>(`/api/agents/${encodeURIComponent(props.name)}`);
      if (!busy.value) fill(a);
      else agent.value = a;
      runs.value = (await api<{ runs: AgentRun[] }>(`/api/agents/${encodeURIComponent(props.name)}/runs`)).runs;
    }
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/** Reload the agent and its runs without touching unsaved edits. */
async function refresh() {
  if (adding.value) return;
  try {
    agent.value = await api<Agent>(`/api/agents/${encodeURIComponent(props.name)}`);
    runs.value = (await api<{ runs: AgentRun[] }>(`/api/agents/${encodeURIComponent(props.name)}/runs`)).runs;
    if (openRun.value) await loadRun(openRun.value.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function body() {
  const d = draft.value;
  return {
    ...(adding.value ? { name: d.name.trim() } : {}),
    description: d.description,
    instructions: d.instructions,
    schedule: d.schedule.trim() || null,
    enabled: d.enabled,
    startable: d.startable,
    tools: d.tools.filter((t) => t.pattern.trim()).map((t) => ({ pattern: t.pattern.trim(), mode: t.mode })),
    budgets: d.budgets,
  };
}

async function save() {
  busy.value = "save";
  try {
    const a = adding.value
      ? await api<Agent>("/api/agents", { method: "POST", json: body() })
      : await api<Agent>(`/api/agents/${encodeURIComponent(props.name)}`, { method: "PUT", json: body() });
    notice.value = a.unmatched.length ? `Saved. Matching no tool right now: ${a.unmatched.join(", ")}` : "Saved";
    emit("saved");
    // The new agent's page is a fresh editor: hand it the notice through the history entry.
    if (adding.value) await router.replace({ path: `/agents/${encodeURIComponent(a.name)}`, state: { notice: notice.value } });
    else fill(a);
  } catch (e) {
    notice.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

async function runNow() {
  busy.value = "run";
  try {
    const { runId } = await api<{ runId: string }>(`/api/agents/${encodeURIComponent(props.name)}/run`, { method: "POST", json: request.value.trim() ? { request: request.value.trim() } : {} });
    request.value = "";
    notice.value = "Started";
    await refresh();
    const run = runs.value.find((r) => r.id === runId);
    if (run) await showRun(run);
  } catch (e) {
    notice.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

async function remove() {
  if (!confirmDelete.value) { confirmDelete.value = true; return; }
  busy.value = "delete";
  try {
    await api(`/api/agents/${encodeURIComponent(props.name)}`, { method: "DELETE" });
    emit("deleted");
  } catch (e) {
    notice.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

const addTool = (pattern = "", mode: ToolEntry["mode"] = "auto") => draft.value.tools.push({ pattern, mode });
const removeTool = (i: number) => draft.value.tools.splice(i, 1);

// ---- runs ------------------------------------------------------------------------------------------------

const runColumns: Column[] = [
  { key: "outcome", label: "", width: "3rem", align: "center" },
  { key: "startedAt", label: "Started" },
  { key: "trigger", label: "Trigger", hideBelow: "md" },
  { key: "duration", label: "Took", hideBelow: "md" },
  { key: "summary", label: "Summary" },
];

type RunDetail = AgentRun & { actions: AgentAction[] };
const openRun = ref<RunDetail | null>(null);
const drawer = ref(false);
const deciding = ref<string | null>(null);

async function loadRun(id: string) {
  openRun.value = await api<RunDetail>(`/api/agents/runs/${encodeURIComponent(id)}`);
}
async function showRun(r: AgentRun) {
  try { await loadRun(r.id); drawer.value = true; } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
async function cancelRun() {
  if (!openRun.value) return;
  try { await api(`/api/agents/runs/${encodeURIComponent(openRun.value.id)}/cancel`, { method: "POST" }); } catch (e) { notice.value = e instanceof Error ? e.message : String(e); }
  await refresh();
}
async function decide(a: AgentAction, how: "approve" | "reject") {
  deciding.value = a.id;
  try { await api(`/api/agents/actions/${encodeURIComponent(a.id)}/${how}`, { method: "POST" }); } catch (e) { notice.value = e instanceof Error ? e.message : String(e); }
  finally { deciding.value = null; }
  await refresh();
  emit("saved");
}

// Poll while a run is going, so the history and an open run settle on their own.
const running = computed(() => !!agent.value?.running || openRun.value?.outcome === "running");
let poll: ReturnType<typeof setInterval> | undefined;
watch(running, (on) => {
  if (on && !poll) poll = setInterval(() => void refresh(), 2000);
  if (!on && poll) { clearInterval(poll); poll = undefined; }
});
onMounted(load);
onBeforeUnmount(() => { if (poll) clearInterval(poll); });

const when = (s: string | null | undefined, fallback = "") => formatDateTime(s, fallback);
const json = (v: unknown) => JSON.stringify(v, null, 2);
const status = computed(() => (agent.value ? agentStatus(agent.value) : null));
const canSave = computed(() => (!adding.value || draft.value.name.trim() !== "") && draft.value.description.trim() !== "" && draft.value.instructions.trim() !== "");
</script>

<template>
  <PageLayout eyebrow="Agents" :title="adding ? 'New agent' : name" :subtitle="adding ? 'Describe the task in text and choose the tools it may use.' : agent?.description">
    <template #actions>
      <Button variant="ghost" @click="router.push('/agents')"><Icon name="chevron" class="rotate-180" />All agents</Button>
      <Button v-if="!adding" variant="danger" :disabled="busy !== null" @click="remove">{{ busy === "delete" ? "Deleting…" : confirmDelete ? "Confirm delete" : "Delete" }}</Button>
    </template>
    <p v-if="error" class="text-f-error">{{ error }}</p>
    <p v-if="notice" class="text-sm text-f-text-muted">{{ notice }}</p>

    <div v-if="agent && status" class="flex flex-wrap items-center gap-3 text-sm">
      <StatusDot :tone="status.tone" :label="status.label" />
      <span class="text-f-text-muted">{{ describeSchedule(agent.schedule) }}</span>
      <span v-if="agent.nextRunAt" class="text-f-text-muted">next {{ when(agent.nextRunAt) }}</span>
      <Badge v-if="agent.pendingActions" tone="accent">{{ agent.pendingActions }} waiting for approval</Badge>
    </div>

    <Card v-if="!adding" title="Run now">
      <div class="flex flex-wrap items-end gap-2">
        <div class="min-w-0 flex-1"><Input v-model="request" label="Request (optional)" placeholder="e.g. only look at this week" /></div>
        <Button :disabled="busy !== null || !!agent?.running" @click="runNow"><Icon name="play" />{{ agent?.running ? "Running…" : "Run now" }}</Button>
      </div>
      <p v-if="agent && !agent.enabled" class="mt-2 text-xs text-f-text-muted">Disabled: it doesn't run on its schedule or by voice, but you can try it here.</p>
    </Card>

    <Card title="Definition">
      <div class="flex flex-col gap-4">
        <Input v-if="adding" v-model="draft.name" label="Name" placeholder="weekly-review" />
        <Input v-model="draft.description" label="Description (one line; voice uses it to pick the agent)" placeholder="Sums up my week every Sunday" />
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-f-text-muted">Instructions</span>
          <textarea v-model="draft.instructions" rows="10" class="surface-inset px-3 py-2 font-mono text-f-text outline-none focus:border-f-accent" placeholder="What the agent should do, which tools to use, and how to report."></textarea>
        </label>
        <div class="flex flex-col gap-1">
          <Input v-model="draft.schedule" label="Schedule (cron, household time zone; empty = only on demand)" placeholder="0 18 * * 0" />
          <span class="text-xs text-f-text-muted">{{ describeSchedule(draft.schedule.trim() || undefined) }}</span>
        </div>
        <div class="flex flex-wrap gap-6 text-sm">
          <label class="flex items-center gap-2"><input v-model="draft.enabled" type="checkbox" class="accent-f-accent" />Enabled</label>
          <label class="flex items-center gap-2"><input v-model="draft.startable" type="checkbox" class="accent-f-accent" />Can be started by voice and chat</label>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label v-for="(b, key) in BUDGETS" :key="key" class="flex flex-col gap-1 text-sm">
            <span class="text-f-text-muted">{{ b.label }} per run ({{ b.min }}–{{ b.max }})</span>
            <input v-model.number="draft.budgets[key]" type="number" :min="b.min" :max="b.max" class="surface-inset px-3 py-2 text-f-text outline-none focus:border-f-accent" />
          </label>
        </div>
      </div>
    </Card>

    <Card title="Tools">
      <div class="flex flex-col gap-3 text-sm">
        <p class="text-xs text-f-text-muted">
          A name or a pattern with <code class="font-mono">*</code>. <strong>auto</strong> runs the tool; <strong>approve</strong> parks the exact call on the run until you approve it.
          Use approve for anything that writes or sends.
        </p>
        <div v-for="(t, i) in draft.tools" :key="i" class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <input v-model="t.pattern" placeholder="calendar_*" class="surface-inset min-w-0 flex-1 px-3 py-2 font-mono text-f-text outline-none focus:border-f-accent" />
            <select v-model="t.mode" class="surface-inset px-3 py-2 text-f-text outline-none focus:border-f-accent">
              <option value="auto">auto</option>
              <option value="approve">approve</option>
            </select>
            <Button variant="ghost" :title="`Remove ${t.pattern}`" @click="removeTool(i)"><Icon name="close" /></Button>
          </div>
          <div class="flex flex-wrap gap-1 pl-1">
            <span v-if="t.pattern.trim() && !matchesOf(t.pattern).length" class="text-xs text-f-warning">matches no tool right now</span>
            <Chip v-for="m in matchesOf(t.pattern)" :key="m">{{ m }}</Chip>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button variant="ghost" @click="addTool()"><Icon name="plus" />Add</Button>
          <Button variant="ghost" @click="showTools = !showTools">{{ showTools ? "Hide" : "Show" }} available tools ({{ tools.length }})</Button>
        </div>
        <ul v-if="showTools" class="flex flex-col gap-1">
          <li v-for="t in tools" :key="t.name" class="flex items-start gap-2">
            <Button variant="ghost" :title="`Add ${t.name}`" @click="addTool(t.name)"><Icon name="plus" /></Button>
            <div class="min-w-0">
              <code class="font-mono text-f-text-bright">{{ t.name }}</code> <Chip>{{ t.owner }}</Chip>
              <p class="text-xs text-f-text-muted line-clamp-2">{{ t.description }}</p>
            </div>
          </li>
        </ul>
      </div>
    </Card>

    <div class="flex justify-end">
      <Button :disabled="busy !== null || !canSave" @click="save">{{ busy === "save" ? "Saving…" : adding ? "Create" : "Save" }}</Button>
    </div>

    <Card v-if="!adding" :title="`Runs (${runs.length})`">
      <DataTable :columns="runColumns" :rows="runs" row-key="id" clickable empty="No runs yet" @row-click="showRun($event as AgentRun)">
        <template #cell-outcome="{ row }"><StatusDot :tone="outcomeTone[(row as AgentRun).outcome]" :title="(row as AgentRun).outcome" /></template>
        <template #cell-startedAt="{ value }"><span class="whitespace-nowrap">{{ when(value as string) }}</span></template>
        <template #cell-trigger="{ value }"><Badge>{{ value }}</Badge></template>
        <template #cell-duration="{ row }"><span class="text-f-text-muted whitespace-nowrap">{{ runDuration(row as AgentRun) }}</span></template>
        <template #cell-summary="{ row }">
          <span v-if="(row as AgentRun).error" class="text-f-error line-clamp-2">{{ (row as AgentRun).error }}</span>
          <span v-else class="text-f-text line-clamp-2">{{ (row as AgentRun).summary }}</span>
        </template>
      </DataTable>
    </Card>

    <Drawer v-model:open="drawer" :title="openRun ? `Run of ${openRun.agent}` : ''" :subtitle="openRun ? when(openRun.startedAt) : ''">
      <template v-if="openRun">
        <div class="flex flex-wrap items-center gap-2">
          <StatusDot :tone="outcomeTone[openRun.outcome]" :label="openRun.outcome.replace('_', ' ')" />
          <Badge>{{ openRun.trigger }}</Badge>
          <span v-if="runDuration(openRun)" class="text-f-text-muted">{{ runDuration(openRun) }}</span>
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <template v-if="openRun.request"><dt class="text-f-text-muted">Request</dt><dd>{{ openRun.request }}</dd></template>
          <dt class="text-f-text-muted">Tool calls</dt><dd>{{ openRun.toolCalls }}<span v-if="agent"> of {{ agent.budgets.maxToolCalls }}</span></dd>
          <dt class="text-f-text-muted">Tokens</dt><dd>{{ openRun.tokens.toLocaleString() }}<span v-if="agent"> of {{ agent.budgets.maxTokens.toLocaleString() }}</span></dd>
          <template v-if="openRun.conversationId">
            <dt class="text-f-text-muted">Transcript</dt>
            <dd><RouterLink class="text-f-accent-bright hover:underline" :to="{ path: '/conversations', query: { id: openRun.conversationId } }">Open the conversation</RouterLink></dd>
          </template>
        </dl>
        <p v-if="openRun.error" class="surface-inset px-3 py-2 font-mono text-xs text-f-error break-words">{{ openRun.error }}</p>
        <p v-else-if="openRun.summary" class="surface-inset px-3 py-2 text-sm text-f-text whitespace-pre-wrap">{{ openRun.summary }}</p>

        <div>
          <h3 class="mb-2 text-sm font-medium text-f-text-bright">Actions for approval ({{ openRun.actions.length }})</h3>
          <p v-if="!openRun.actions.length" class="text-sm text-f-text-muted">None</p>
          <ul v-else class="flex flex-col gap-2">
            <li v-for="a in openRun.actions" :key="a.id" class="surface-inset flex flex-col gap-2 p-3 text-sm">
              <div class="flex flex-wrap items-center gap-2">
                <StatusDot :tone="actionTone[a.state]" :label="a.state" />
                <code class="font-mono text-f-text-bright">{{ a.tool }}</code>
                <span class="ml-auto text-xs text-f-text-muted">{{ when(a.createdAt) }}</span>
              </div>
              <pre class="max-h-60 overflow-auto font-mono text-xs text-f-text whitespace-pre-wrap break-words">{{ json(a.args) }}</pre>
              <p v-if="a.error" class="font-mono text-xs text-f-error break-words">{{ a.error }}</p>
              <pre v-else-if="a.result !== null" class="max-h-40 overflow-auto font-mono text-xs text-f-text-muted whitespace-pre-wrap break-words">{{ json(a.result) }}</pre>
              <div v-if="a.state === 'pending'" class="flex gap-2">
                <Button :disabled="deciding !== null" @click="decide(a, 'approve')">{{ deciding === a.id ? "Running…" : "Approve" }}</Button>
                <Button variant="ghost" :disabled="deciding !== null" @click="decide(a, 'reject')">Reject</Button>
              </div>
            </li>
          </ul>
        </div>
      </template>
      <template #footer>
        <Button v-if="openRun?.outcome === 'running'" variant="danger" @click="cancelRun">Cancel run</Button>
      </template>
    </Drawer>
  </PageLayout>
</template>
