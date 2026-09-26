<script setup lang="ts">
import { onMounted, ref } from "vue";
import { PageLayout, Button, Input, DataTable, StatusDot, Chip, Drawer, Icon, formatDateTime, type Column } from "@friday/portal-ui";
import { api } from "../../composables/useApi.js";

interface KeyRecord extends Record<string, unknown> {
  id: string;
  moduleId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
}

const keys = ref<KeyRecord[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);
const open = ref(false);
const moduleId = ref("");
const label = ref("");
const created = ref<{ key: string; moduleId: string } | null>(null);
const copied = ref(false);
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/modules`;

const columns: Column[] = [
  { key: "status", label: "", width: "3rem", align: "center" },
  { key: "moduleId", label: "Module" },
  { key: "label", label: "Label" },
  { key: "createdAt", label: "Created", hideBelow: "md" },
  { key: "lastSeenAt", label: "Last seen", hideBelow: "md" },
];

async function load() {
  try { keys.value = await api<KeyRecord[]>("/api/keys"); error.value = null; }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
onMounted(load);

function openNew() { moduleId.value = ""; label.value = ""; created.value = null; copied.value = false; open.value = true; }

async function create() {
  busy.value = true;
  try {
    const r = await api<KeyRecord & { key: string }>("/api/keys", { method: "POST", json: { moduleId: moduleId.value.trim(), label: label.value.trim() } });
    created.value = { key: r.key, moduleId: r.moduleId };
    await load();
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); } finally { busy.value = false; }
}
async function copy() { if (created.value) { await navigator.clipboard.writeText(created.value.key); copied.value = true; } }
async function revoke(k: KeyRecord) {
  busy.value = true;
  try { await api(`/api/keys/${k.id}`, { method: "DELETE" }); await load(); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); } finally { busy.value = false; }
}
const when = (s: string | null) => formatDateTime(s, "never");
</script>

<template>
  <PageLayout eyebrow="System" title="Remote modules" subtitle="API keys that let a module on another machine connect to /ws/modules.">
    <template #actions>
      <Button variant="ghost" :disabled="busy" @click="load"><Icon name="refresh" />Refresh</Button>
      <Button @click="openNew"><Icon name="plus" />New key</Button>
    </template>
    <p v-if="error" class="text-f-error">{{ error }}</p>

    <DataTable :columns="columns" :rows="keys" row-key="id" empty="No keys yet">
      <template #cell-status="{ row }"><StatusDot :tone="(row as KeyRecord).revoked ? 'error' : 'success'" :title="(row as KeyRecord).revoked ? 'revoked' : 'active'" /></template>
      <template #cell-moduleId="{ value }"><Chip>{{ value }}</Chip></template>
      <template #cell-createdAt="{ value }"><span class="text-f-text-muted whitespace-nowrap">{{ when(value as string) }}</span></template>
      <template #cell-lastSeenAt="{ value }"><span class="text-f-text-muted whitespace-nowrap">{{ when(value as string | null) }}</span></template>
      <template #actions="{ row }">
        <Button v-if="!(row as KeyRecord).revoked" variant="danger" :disabled="busy" @click="revoke(row as KeyRecord)">Revoke</Button>
      </template>
    </DataTable>

    <Drawer v-model:open="open" title="New key" subtitle="The key is shown once and stored as a hash.">
      <template v-if="!created">
        <Input v-model="moduleId" label="Module id" placeholder="simracing" />
        <Input v-model="label" label="Label" placeholder="gaming pc" />
      </template>
      <template v-else>
        <p class="text-f-warning text-sm">Copy this key now. It will not be shown again.</p>
        <div class="surface-inset p-3 flex flex-wrap items-center gap-2">
          <code class="font-mono text-f-text-bright break-all flex-1">{{ created.key }}</code>
          <Button variant="ghost" @click="copy">{{ copied ? "Copied" : "Copy" }}</Button>
        </div>
        <p class="text-sm text-f-text-muted">On the remote machine:</p>
        <pre class="surface-inset p-3 text-xs font-mono overflow-x-auto">FRIDAY_URL={{ wsUrl }}
FRIDAY_MODULE_KEY=&lt;the key above&gt;
# module id: {{ created.moduleId }}</pre>
      </template>
      <template #footer>
        <Button v-if="!created" :disabled="busy || !moduleId.trim()" @click="create">Create</Button>
        <Button v-else @click="open = false">Done</Button>
      </template>
    </Drawer>
  </PageLayout>
</template>
