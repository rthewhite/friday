<script setup lang="ts">
import { onMounted, ref } from "vue";
import { PageLayout, Button, DataTable, StatusDot, Badge, Chip, Drawer, Icon, formatDateTime, type Column } from "@friday/portal-ui";
import { useModules, type ApiModule } from "../composables/useModules.js";
import { api } from "../composables/useApi.js";

const { modules, loading, error, refreshModules } = useModules();
onMounted(() => void refreshModules());

const columns: Column[] = [
  { key: "status", label: "", width: "3rem", align: "center" },
  { key: "label", label: "Module" },
  { key: "kind", label: "Kind", hideBelow: "md" },
  { key: "tools", label: "Tools", align: "right", width: "6rem" },
];
const tone = (s: ApiModule["status"]) => (s === "loaded" || s === "connected" ? "success" : s === "failed" ? "error" : "neutral");
const kind = (m: ApiModule) => (m.id.startsWith("mcp:") ? "MCP server" : m.status === "connected" ? "remote" : "in-process");
const reloadable = (m: ApiModule) => !m.id.startsWith("mcp:") && m.status !== "connected" && m.status !== "disabled";

const reloading = ref<string | null>(null);
async function reload(m: ApiModule) {
  reloading.value = m.id;
  try { await api(`/api/modules/${m.id}/reload`, { method: "POST" }); await refreshModules(); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { reloading.value = null; }
}

const open = ref(false);
const selected = ref<ApiModule | null>(null);
function show(m: ApiModule) { selected.value = m; open.value = true; }
</script>

<template>
  <PageLayout eyebrow="Modules" title="Modules" subtitle="What this Friday can do right now.">
    <template #actions>
      <Button variant="ghost" :disabled="loading" @click="refreshModules"><Icon name="refresh" />Refresh</Button>
    </template>
    <p v-if="error" class="text-f-error">{{ error }}</p>

    <DataTable :columns="columns" :rows="modules as unknown as Record<string, unknown>[]" row-key="id" clickable @row-click="show($event as unknown as ApiModule)">
      <template #cell-status="{ row }"><StatusDot :tone="tone((row as unknown as ApiModule).status)" :title="(row as unknown as ApiModule).status" /></template>
      <template #cell-label="{ row }">
        <div class="font-medium text-f-text-bright">{{ (row as unknown as ApiModule).label }}</div>
        <div class="text-xs text-f-text-muted">{{ (row as unknown as ApiModule).id }}</div>
      </template>
      <template #cell-kind="{ row }"><Badge>{{ kind(row as unknown as ApiModule) }}</Badge></template>
      <template #cell-tools="{ row }">{{ (row as unknown as ApiModule).tools.length }}</template>
      <template #actions="{ row }">
        <div class="flex items-center justify-end gap-2">
          <RouterLink v-if="(row as unknown as ApiModule).ui && (row as unknown as ApiModule).status === 'loaded'" :to="`/m/${(row as unknown as ApiModule).id}`"><Button variant="ghost">Open</Button></RouterLink>
          <Button v-if="reloadable(row as unknown as ApiModule)" variant="ghost" :disabled="reloading === (row as unknown as ApiModule).id" @click="reload(row as unknown as ApiModule)">{{ reloading === (row as unknown as ApiModule).id ? "Reloading…" : "Reload" }}</Button>
        </div>
      </template>
    </DataTable>

    <Drawer v-model:open="open" :title="selected?.label ?? ''" :subtitle="selected?.description">
      <template v-if="selected">
        <div class="flex flex-wrap items-center gap-2">
          <StatusDot :tone="tone(selected.status)" :label="selected.status" />
          <Badge>{{ kind(selected) }}</Badge>
          <Chip>{{ selected.id }}</Chip>
        </div>
        <p v-if="selected.error" class="text-f-error text-sm font-mono">{{ selected.error }}</p>
        <p v-if="selected.connectedAt" class="text-sm text-f-text-muted">Connected {{ formatDateTime(selected.connectedAt) }}</p>
        <div>
          <h3 class="text-sm font-medium text-f-text-bright mb-2">Tools ({{ selected.tools.length }})</h3>
          <div v-if="selected.tools.length" class="flex flex-wrap gap-1.5"><Chip v-for="t in selected.tools" :key="t">{{ t }}</Chip></div>
          <p v-else class="text-sm text-f-text-muted">No tools</p>
        </div>
      </template>
      <template #footer>
        <RouterLink v-if="selected?.ui && selected.status === 'loaded'" :to="`/m/${selected.id}`"><Button variant="ghost">Open page</Button></RouterLink>
        <Button v-if="selected && reloadable(selected)" :disabled="reloading === selected.id" @click="reload(selected)">Reload</Button>
      </template>
    </Drawer>
  </PageLayout>
</template>
