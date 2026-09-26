<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { PageLayout, Card, Badge, Button, Input } from "@friday/portal-ui";
import { api } from "../../composables/useApi.js";
import { refreshModules } from "../../composables/useModules.js";

interface Entry {
  module: string;
  key: string;
  required: boolean;
  description?: string;
  status: "set" | "pending" | "env";
  scope?: string;
}

const enabled = ref(true);
const entries = ref<Entry[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);
const editing = ref<{ module: string; key: string; scope: string; value: string } | null>(null);
const notice = ref<string | null>(null);

async function load() {
  try {
    const r = await api<{ enabled: boolean; entries: Entry[] }>("/api/config");
    enabled.value = r.enabled;
    entries.value = r.entries;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(load);

const groups = computed(() => {
  const map = new Map<string, Entry[]>();
  for (const e of entries.value) map.set(e.module, [...(map.get(e.module) ?? []), e]);
  return [...map.entries()].map(([module, items]) => ({ module, items }));
});

const tone = (s: Entry["status"]) => (s === "set" ? "success" : s === "env" ? "accent" : "warning");

function edit(e: Entry) {
  editing.value = { module: e.module, key: e.key, scope: e.scope === "global" || e.module === "global" ? "global" : e.module, value: "" };
  notice.value = null;
}

async function save(reload: boolean) {
  if (!editing.value) return;
  const { module, key, scope, value } = editing.value;
  busy.value = true;
  try {
    await api(`/api/config/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`, { method: "PUT", json: { value } });
    if (reload && module !== "global") {
      const m = await api<{ status: string; error?: string }>(`/api/modules/${module}/reload`, { method: "POST" });
      notice.value = m.status === "loaded" ? `${module} reloaded` : `${module} still ${m.status}: ${m.error ?? ""}`;
      await refreshModules();
    } else {
      notice.value = `${key} saved`;
    }
    editing.value = null;
    await load();
  } catch (e) {
    notice.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function clear(e: Entry) {
  if (!e.scope) return;
  busy.value = true;
  try {
    await api(`/api/config/${encodeURIComponent(e.scope)}/${encodeURIComponent(e.key)}`, { method: "DELETE" });
    notice.value = `${e.key} cleared`;
    await load();
  } catch (err) {
    notice.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PageLayout title="Configuration" subtitle="Values modules declare. Stored encrypted; environment values are shown but cannot be changed here.">
    <Card v-if="!enabled">
      <p class="text-f-warning">
        The configuration store is disabled because <code class="font-mono">FRIDAY_MASTER_KEY</code> is not set.
        Generate one with <code class="font-mono">openssl rand -base64 32</code>, add it to the server's secret, and restart. Until then only environment values apply.
      </p>
    </Card>
    <p v-if="error" class="text-f-error">{{ error }}</p>
    <p v-if="notice" class="text-f-text-muted">{{ notice }}</p>

    <Card v-for="g in groups" :key="g.module" :title="g.module">
      <ul class="flex flex-col divide-y divide-f-border-subtle">
        <li v-for="e in g.items" :key="e.key" class="py-3 flex flex-col gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <code class="font-mono text-f-text-bright">{{ e.key }}</code>
            <Badge :tone="tone(e.status)">{{ e.status }}<template v-if="e.scope"> · {{ e.scope }}</template></Badge>
            <Badge v-if="e.required" tone="neutral">required</Badge>
            <span class="flex-1"></span>
            <Button variant="ghost" :disabled="busy || !enabled" @click="edit(e)">{{ e.status === "set" ? "Change" : "Set" }}</Button>
            <Button v-if="e.status === 'set'" variant="danger" :disabled="busy" @click="clear(e)">Clear</Button>
          </div>
          <p v-if="e.description" class="text-f-text-muted text-sm">{{ e.description }}</p>
          <form v-if="editing && editing.module === e.module && editing.key === e.key" class="surface-inset p-3 flex flex-wrap items-end gap-3" @submit.prevent="save(true)">
            <div class="flex-1 min-w-48"><Input v-model="editing.value" label="Value" placeholder="Enter a new value" /></div>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-f-text-muted">Scope</span>
              <select v-model="editing.scope" class="surface-inset px-3 py-2 text-f-text outline-none focus:border-f-accent">
                <option v-if="e.module !== 'global'" :value="e.module">{{ e.module }} only</option>
                <option value="global">global (all modules)</option>
              </select>
            </label>
            <Button v-if="e.module !== 'global'" type="submit" :disabled="busy || !editing.value">Save and reload module</Button>
            <Button variant="ghost" :disabled="busy || !editing.value" @click="save(false)">Save</Button>
            <Button variant="ghost" :disabled="busy" @click="editing = null">Cancel</Button>
          </form>
        </li>
      </ul>
    </Card>
  </PageLayout>
</template>
