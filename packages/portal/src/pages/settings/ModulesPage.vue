<script setup lang="ts">
import { onMounted, ref } from "vue";
import { PageLayout, Button, DataTable, StatusDot, Badge, Chip, Drawer, Icon, formatDateTime, type Column } from "@friday/portal-ui";
import { useModules, type ApiModule } from "../../composables/useModules.js";
import { api } from "../../composables/useApi.js";
import { isReloadable, isSwitchedOn, isToggleable, moduleKind, moduleTone } from "../../lib/modules.js";

const { modules, loading, error, refreshModules, setModuleEnabled } = useModules();
onMounted(() => void refreshModules());

const columns: Column[] = [
  { key: "status", label: "", width: "3rem", align: "center" },
  { key: "label", label: "Module" },
  { key: "kind", label: "Kind", hideBelow: "md" },
  { key: "tools", label: "Tools", align: "right", width: "6rem" },
];

const reloading = ref<string | null>(null);
async function reload(m: ApiModule) {
  reloading.value = m.id;
  try { await api(`/api/modules/${m.id}/reload`, { method: "POST" }); await refreshModules(); syncSelected(); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { reloading.value = null; }
}

const open = ref(false);
const selected = ref<ApiModule | null>(null);
function show(m: ApiModule) { selected.value = m; confirmingOff.value = false; switchError.value = null; open.value = true; }
/** Point the drawer at the refreshed entry of the module it shows. */
function syncSelected() {
  if (selected.value) selected.value = modules.value.find((m) => m.id === selected.value!.id) ?? selected.value;
}

// Turning a module off stops its tools, pages and jobs, so it is confirmed in the drawer first; turning it on is not.
const confirmingOff = ref(false);
/** Modules whose switch request is in flight; each keeps its switch locked until its own answer arrives. */
const switching = ref(new Set<string>());
const switchError = ref<string | null>(null);

function onSwitch(m: ApiModule, event: Event) {
  // The checkbox follows the module's status, never the click: it moves once the server has answered.
  (event.target as HTMLInputElement).checked = isSwitchedOn(m);
  if (isSwitchedOn(m)) {
    show(m);
    confirmingOff.value = true;
  } else {
    void setEnabled(m, true);
  }
}

async function setEnabled(m: ApiModule, enabled: boolean) {
  switching.value = new Set(switching.value).add(m.id);
  switchError.value = null;
  try {
    const entry = await setModuleEnabled(m.id, enabled);
    if (selected.value?.id === m.id) selected.value = entry;
    confirmingOff.value = false;
  } catch (e) {
    switchError.value = e instanceof Error ? e.message : String(e);
    if (!open.value) error.value = switchError.value;
  } finally {
    const rest = new Set(switching.value);
    rest.delete(m.id);
    switching.value = rest;
  }
}
</script>

<template>
  <PageLayout eyebrow="System" title="Modules" subtitle="What this Friday can do. Turn off what doesn't apply here.">
    <template #actions>
      <Button variant="ghost" :disabled="loading" @click="refreshModules"><Icon name="refresh" />Refresh</Button>
    </template>
    <p v-if="error" class="text-f-error">{{ error }}</p>

    <DataTable :columns="columns" :rows="modules as unknown as Record<string, unknown>[]" row-key="id" clickable @row-click="show($event as unknown as ApiModule)">
      <template #cell-status="{ row }"><StatusDot :tone="moduleTone((row as unknown as ApiModule).status)" :title="(row as unknown as ApiModule).status" /></template>
      <template #cell-label="{ row }">
        <div class="font-medium text-f-text-bright">{{ (row as unknown as ApiModule).label }}</div>
      </template>
      <template #cell-kind="{ row }"><Badge>{{ moduleKind(row as unknown as ApiModule) }}</Badge></template>
      <template #cell-tools="{ row }">{{ (row as unknown as ApiModule).tools.length }}</template>
      <template #actions="{ row }">
        <div class="flex items-center justify-end gap-2">
          <RouterLink v-if="(row as unknown as ApiModule).ui && (row as unknown as ApiModule).status === 'loaded'" :to="`/m/${(row as unknown as ApiModule).id}`"><Button variant="ghost">Open</Button></RouterLink>
          <Button v-if="isReloadable(row as unknown as ApiModule)" variant="ghost" :disabled="reloading === (row as unknown as ApiModule).id" @click="reload(row as unknown as ApiModule)">{{ reloading === (row as unknown as ApiModule).id ? "Reloading…" : "Reload" }}</Button>
          <label v-if="isToggleable(row as unknown as ApiModule)" class="flex items-center gap-2 text-sm" @click.stop>
            <input
              type="checkbox"
              class="accent-f-accent"
              :checked="isSwitchedOn(row as unknown as ApiModule)"
              :disabled="switching.has((row as unknown as ApiModule).id)"
              :aria-label="`${(row as unknown as ApiModule).label} enabled`"
              @change="onSwitch(row as unknown as ApiModule, $event)"
            />
            <span class="hidden sm:inline">Enabled</span>
          </label>
        </div>
      </template>
    </DataTable>

    <Drawer v-model:open="open" :title="selected?.label ?? ''" :subtitle="selected?.description">
      <template v-if="selected">
        <div class="flex flex-wrap items-center gap-2">
          <StatusDot :tone="moduleTone(selected.status)" :label="selected.status" />
          <Badge>{{ moduleKind(selected) }}</Badge>
          <Chip>{{ selected.id }}</Chip>
        </div>
        <label v-if="isToggleable(selected)" class="flex items-center gap-2 text-sm">
          <input type="checkbox" class="accent-f-accent" :checked="isSwitchedOn(selected)" :disabled="switching.has(selected.id)" @change="onSwitch(selected, $event)" />
          <span>Enabled</span>
        </label>
        <div v-if="confirmingOff && isSwitchedOn(selected)" class="surface-inset px-3 py-2 text-sm flex flex-col gap-2">
          <p>Turn off {{ selected.label }}? Its tools, pages and jobs stop. Its data and settings are kept, and turning it on again picks them up.</p>
          <div class="flex gap-2">
            <Button variant="danger" :disabled="switching.has(selected.id)" @click="setEnabled(selected, false)">{{ switching.has(selected.id) ? "Turning off…" : "Turn off" }}</Button>
            <Button variant="ghost" :disabled="switching.has(selected.id)" @click="confirmingOff = false">Cancel</Button>
          </div>
        </div>
        <p v-if="switchError" class="text-f-error text-sm">{{ switchError }}</p>
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
        <Button v-if="selected && isReloadable(selected)" :disabled="reloading === selected.id" @click="reload(selected)">Reload</Button>
      </template>
    </Drawer>
  </PageLayout>
</template>
