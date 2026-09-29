<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { PageLayout, Button, Input, DataTable, Tabs, StatusDot, Chip, Drawer, Card, formatDateTime, type Column } from "@friday/portal-ui";
import { api } from "../../composables/useApi.js";
import { refreshModules } from "../../composables/useModules.js";
import { defaultScope } from "../../lib/config-scope.js";
import { ownCopies, scopeSummary, strayCopies } from "../../lib/config-stored.js";
import McpServersTab from "./McpServersTab.vue";

interface Entry extends Record<string, unknown> {
  key: string;
  secret: boolean;
  required: boolean;
  description?: string;
  modules: { id: string; required: boolean }[];
  status: "set" | "pending" | "env";
  scope?: string;
  updatedAt?: string;
  value?: string;
  /** Every scope the key is stored in (global first); plain values only. */
  stored?: { scope: string; updatedAt: string; value?: string }[];
}
type Tab = "config" | "secrets" | "mcp";

const route = useRoute();
const router = useRouter();
const tab = computed<Tab>(() => (route.query.tab === "secrets" || route.query.tab === "mcp" ? route.query.tab : "config"));
const setTab = (t: string) => router.replace({ query: { ...route.query, tab: t, key: undefined, server: undefined } });
const mcpTab = ref<InstanceType<typeof McpServersTab> | null>(null);
const mcpCount = ref(0);

const secretsEnabled = ref(true);
const entries = ref<Entry[]>([]);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

async function load() {
  try {
    const r = await api<{ secretsEnabled: boolean; entries: Entry[] }>("/api/config");
    secretsEnabled.value = r.secretsEnabled;
    entries.value = r.entries;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(async () => { await load(); openFromQuery(); });

const plain = computed(() => entries.value.filter((e) => !e.secret));
const secrets = computed(() => entries.value.filter((e) => e.secret));
const rows = computed(() => (tab.value === "secrets" ? secrets.value : plain.value));
const tabs = computed(() => [
  { id: "config", label: "Configuration", count: plain.value.length },
  { id: "secrets", label: "Secrets", count: secrets.value.length },
  { id: "mcp", label: "MCP servers", count: mcpCount.value },
]);
const columns = computed<Column[]>(() => [
  { key: "status", label: "", width: "3rem", align: "center" as const },
  { key: "key", label: "Key" },
  { key: "description", label: "Description", hideBelow: "lg" as const },
  { key: "modules", label: "Requested by", hideBelow: "md" as const },
  { key: "scope", label: "Scope", hideBelow: "md" as const, width: "9rem" },
  { key: "updatedAt", label: "Updated", hideBelow: "lg" as const, width: "11rem" },
]);
const tone = (s: Entry["status"]) => (s === "set" ? "success" : s === "env" ? "accent" : "warning");
const when = (s?: string) => formatDateTime(s);

// ---- drawer ---------------------------------------------------------------
const open = ref(false);
const selected = ref<Entry | null>(null);
/** Adding a new global value: the key is editable. */
const adding = ref(false);
const draft = ref({ key: "", value: "", scope: "global" });

function openEntry(e: Entry) {
  selected.value = e;
  adding.value = false;
  draft.value = { key: e.key, value: e.secret ? "" : (e.value ?? ""), scope: defaultScope(e) };
  open.value = true;
  router.replace({ query: { ...route.query, key: e.key } });
}
function openAdd() {
  selected.value = null;
  adding.value = true;
  draft.value = { key: "", value: "", scope: "global" };
  open.value = true;
}
function openFromQuery() {
  const k = route.query.key;
  const e = entries.value.find((x) => x.key === k);
  if (e) openEntry(e);
}
watch(open, (v) => { if (!v && route.query.key) router.replace({ query: { ...route.query, key: undefined } }); });
watch(() => route.query.key, (k) => { if (k && !open.value) openFromQuery(); });

const scopeOptions = computed(() => [...(selected.value?.modules.map((m) => m.id) ?? []), "global"]);
const hasGlobal = computed(() => selected.value?.stored?.some((s) => s.scope === "global") === true);
// Core is not a reloadable module: its keys apply to the next voice session and model call.
const canReload = computed(() => draft.value.scope !== "global" && draft.value.scope !== "core");
const isSecret = computed(() => (adding.value ? tab.value === "secrets" : selected.value?.secret === true));

async function save(reload: boolean) {
  const key = draft.value.key.trim();
  if (!key || !draft.value.value) return;
  await run(async () => {
    await api(`/api/config/${encodeURIComponent(draft.value.scope)}/${encodeURIComponent(key)}`, { method: "PUT", json: { value: draft.value.value, secret: isSecret.value } });
    if (reload && canReload.value) {
      const m = await api<{ status: string; error?: string }>(`/api/modules/${draft.value.scope}/reload`, { method: "POST" });
      notice.value = m.status === "loaded" ? `${key} saved, ${draft.value.scope} reloaded` : `${key} saved, but ${draft.value.scope} is ${m.status}: ${m.error ?? ""}`;
      await refreshModules();
    } else {
      notice.value = `${key} saved`;
    }
    open.value = false;
  });
}
/** Clear one stored copy; the others (and the environment) stay. The drawer stays open on the refreshed entry. */
async function clear(scope: string) {
  const e = selected.value;
  if (!e) return;
  await run(async () => {
    await api(`/api/config/${encodeURIComponent(scope)}/${encodeURIComponent(e.key)}`, { method: "DELETE" });
    notice.value = `${e.key} cleared for ${scope}`;
  });
  const fresh = entries.value.find((x) => x.key === e.key);
  if (fresh) {
    selected.value = fresh;
    if (draft.value.scope === scope) draft.value.scope = defaultScope(fresh);
  }
}
async function run(f: () => Promise<void>) {
  busy.value = true;
  try { await f(); await load(); } catch (e) { notice.value = e instanceof Error ? e.message : String(e); } finally { busy.value = false; }
}
</script>

<template>
  <PageLayout eyebrow="System" title="Configuration" subtitle="Configuration and secrets requested by Friday's modules, and the MCP servers Friday connects to. Stored values win over the environment.">
    <template #actions>
      <Button variant="ghost" :disabled="busy" @click="tab === 'mcp' ? mcpTab?.load() : load()"><Icon name="refresh" />Refresh</Button>
      <Button v-if="tab === 'mcp'" @click="mcpTab?.openAdd()"><Icon name="plus" />New server</Button>
      <Button v-else :disabled="tab === 'secrets' && !secretsEnabled" @click="openAdd"><Icon name="plus" />{{ tab === "secrets" ? "New secret" : "New value" }}</Button>
    </template>

    <Tabs :items="tabs" :model-value="tab" @update:model-value="setTab" />

    <!-- Always mounted so the tab count is known; hidden unless active. -->
    <McpServersTab v-show="tab === 'mcp'" ref="mcpTab" @count="mcpCount = $event" />

    <template v-if="tab !== 'mcp'">
      <Card v-if="tab === 'secrets' && !secretsEnabled">
        <p class="text-f-warning">
          Secrets are disabled because <code class="font-mono">FRIDAY_MASTER_KEY</code> is not set. Generate one with <code class="font-mono">openssl rand -base64 32</code>, add it to the server's secret, and restart. Plain configuration keeps working.
        </p>
      </Card>
      <p v-if="error" class="text-f-error">{{ error }}</p>
      <p v-if="notice" class="text-f-text-muted">{{ notice }}</p>

      <DataTable :columns="columns" :rows="rows" row-key="key" clickable :empty="tab === 'secrets' ? 'No secrets declared' : 'No configuration declared'" @row-click="openEntry">
        <template #cell-status="{ row }"><StatusDot :tone="tone((row as Entry).status)" :title="(row as Entry).status" /></template>
        <template #cell-key="{ row }">
          <code class="font-mono text-f-text-bright">{{ (row as Entry).key }}</code>
          <span v-if="(row as Entry).required" class="ml-2 text-xs text-f-text-muted">required</span>
        </template>
        <template #cell-description="{ row }"><span class="text-f-text-muted">{{ (row as Entry).description ?? "" }}</span></template>
        <template #cell-modules="{ row }">
          <div class="flex flex-wrap gap-1.5">
            <Chip v-for="m in (row as Entry).modules" :key="m.id">{{ m.id }}</Chip>
            <Chip v-if="!(row as Entry).modules.length">global</Chip>
          </div>
        </template>
        <template #cell-scope="{ row }">
          <span class="text-f-text-muted whitespace-nowrap">
            {{ scopeSummary(row as Entry).scope }}<span v-if="scopeSummary(row as Entry).others.length" class="ml-1 text-f-warning" :title="`Also stored for ${scopeSummary(row as Entry).others.join(', ')}`">+{{ scopeSummary(row as Entry).others.length }}</span>
          </span>
        </template>
        <template #cell-updatedAt="{ row }"><span class="text-f-text-muted whitespace-nowrap">{{ when((row as Entry).updatedAt) }}</span></template>
      </DataTable>

      <Drawer v-model:open="open" :title="adding ? (isSecret ? 'New secret' : 'New value') : draft.key" :subtitle="selected?.description">
        <div v-if="selected?.modules.length" class="flex flex-wrap items-center gap-1.5 text-sm text-f-text-muted">
          Requested by <Chip v-for="m in selected.modules" :key="m.id">{{ m.id }}{{ m.required ? " · required" : "" }}</Chip>
        </div>
        <div v-if="selected" class="flex items-center gap-2 text-sm">
          <StatusDot :tone="tone(selected.status)" :label="selected.status" />
          <span v-if="selected.status === 'env'" class="text-f-text-muted">from the environment</span>
        </div>
        <div v-if="selected?.stored?.length" class="flex flex-col gap-1.5 text-sm">
          <span class="text-f-text-muted">Stored values</span>
          <div v-for="s in selected.stored" :key="s.scope" class="surface-inset flex items-center gap-3 px-3 py-2">
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <div class="flex min-w-0 items-center gap-2">
                <Chip>{{ s.scope }}</Chip>
                <code v-if="s.value !== undefined" class="min-w-0 break-all font-mono text-f-text">{{ s.value }}</code>
              </div>
              <div class="text-xs text-f-text-muted">
                <span v-if="hasGlobal && ownCopies(selected).includes(s.scope)" class="text-f-warning">Overrides global for {{ s.scope }} · </span>
                <span v-else-if="strayCopies(selected).includes(s.scope)">Not requested by {{ s.scope }}, probably left over · </span>
                {{ when(s.updatedAt) }}
              </div>
            </div>
            <Button variant="ghost" :disabled="busy" @click="clear(s.scope)">Clear</Button>
          </div>
        </div>
        <Input v-if="adding" v-model="draft.key" label="Key" placeholder="MY_SETTING" />
        <Input v-model="draft.value" :type="isSecret ? 'password' : 'text'" label="Value" :placeholder="isSecret ? 'Enter a new value' : ''" />
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-f-text-muted">Scope</span>
          <select v-model="draft.scope" class="surface-inset px-3 py-2 text-f-text outline-none focus:border-f-accent">
            <option v-for="s in scopeOptions" :key="s" :value="s">{{ s === "global" ? "global (all modules)" : `${s} only` }}</option>
          </select>
        </label>
        <p v-if="isSecret" class="text-xs text-f-text-muted">Stored encrypted. Not shown again after saving.</p>
        <p v-if="draft.scope === 'global' && selected && ownCopies(selected).length" class="text-xs text-f-warning">
          {{ ownCopies(selected).length === 1 ? `${ownCopies(selected)[0]} keeps its own value until you clear it above.` : `${ownCopies(selected).join(", ")} keep their own values until you clear them above.` }}
        </p>
        <p v-if="draft.scope === 'core' && draft.key === 'FRIDAY_TIMEZONE'" class="text-xs text-f-text-muted">Re-plans cron jobs at once. A core-only value is not seen by modules; save it as global to reach them too.</p>
        <p v-else-if="draft.scope === 'core'" class="text-xs text-f-text-muted">Applies to the next voice session and model call.</p>
        <template #footer>
          <span class="flex-1"></span>
          <Button :variant="canReload ? 'ghost' : undefined" :disabled="busy || !draft.value || !draft.key.trim()" @click="save(false)">Save</Button>
          <Button v-if="canReload" :disabled="busy || !draft.value || !draft.key.trim()" @click="save(true)">Save and reload {{ draft.scope }}</Button>
        </template>
      </Drawer>
    </template>
  </PageLayout>
</template>

<script lang="ts">
import { Icon } from "@friday/portal-ui";
export default { components: { Icon } };
</script>
