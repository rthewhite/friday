<script setup lang="ts">
import { onMounted, ref } from "vue";
import { PageLayout, Card, Badge, Button, Input, Table } from "@friday/portal-ui";
import { api } from "../../composables/useApi.js";

interface KeyRecord {
  id: string;
  moduleId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
  [k: string]: unknown;
}

const keys = ref<KeyRecord[]>([]);
const moduleId = ref("");
const label = ref("");
const created = ref<{ key: string; moduleId: string } | null>(null);
const copied = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

const columns = [
  { key: "moduleId", label: "Module" },
  { key: "label", label: "Label" },
  { key: "createdAt", label: "Created" },
  { key: "lastSeenAt", label: "Last seen" },
  { key: "revoked", label: "Status" },
];

async function load() {
  try {
    keys.value = await api<KeyRecord[]>("/api/keys");
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(load);

async function create() {
  busy.value = true;
  copied.value = false;
  try {
    const r = await api<KeyRecord & { key: string }>("/api/keys", { method: "POST", json: { moduleId: moduleId.value.trim(), label: label.value.trim() } });
    created.value = { key: r.key, moduleId: r.moduleId };
    moduleId.value = "";
    label.value = "";
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function copy() {
  if (!created.value) return;
  await navigator.clipboard.writeText(created.value.key);
  copied.value = true;
}

async function revoke(k: KeyRecord) {
  busy.value = true;
  try {
    await api(`/api/keys/${k.id}`, { method: "DELETE" });
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

const when = (s: string | null) => (s ? new Date(s).toLocaleString() : "never");
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/modules`;
</script>

<template>
  <PageLayout title="Remote modules" subtitle="API keys that let a module on another machine connect to /ws/modules">
    <Card title="Create a key">
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="create">
        <div class="min-w-48"><Input v-model="moduleId" label="Module id" placeholder="simracing" /></div>
        <div class="flex-1 min-w-48"><Input v-model="label" label="Label" placeholder="gaming pc" /></div>
        <Button type="submit" :disabled="busy || !moduleId.trim()">Create</Button>
      </form>
      <div v-if="created" class="surface-inset p-3 flex flex-col gap-2">
        <p class="text-f-warning text-sm">Copy this key now. It is shown once and stored only as a hash.</p>
        <div class="flex flex-wrap items-center gap-2">
          <code class="font-mono text-f-text-bright break-all">{{ created.key }}</code>
          <Button variant="ghost" @click="copy">{{ copied ? "Copied" : "Copy" }}</Button>
        </div>
        <p class="text-f-text-muted text-sm">
          On the remote machine: <code class="font-mono">FRIDAY_URL={{ wsUrl }}</code>
          <code class="font-mono">FRIDAY_MODULE_KEY=…</code> with module id <code class="font-mono">{{ created.moduleId }}</code>.
        </p>
      </div>
      <p v-if="error" class="text-f-error">{{ error }}</p>
    </Card>
    <Table :columns="columns" :rows="keys" row-key="id" empty="No keys yet">
      <template #cell-createdAt="{ value }">{{ when(value as string) }}</template>
      <template #cell-lastSeenAt="{ value }">{{ when(value as string | null) }}</template>
      <template #cell-revoked="{ value }"><Badge :tone="value ? 'error' : 'success'">{{ value ? "revoked" : "active" }}</Badge></template>
      <template #actions="{ row }">
        <Button v-if="!row.revoked" variant="danger" :disabled="busy" @click="revoke(row as KeyRecord)">Revoke</Button>
      </template>
    </Table>
  </PageLayout>
</template>
