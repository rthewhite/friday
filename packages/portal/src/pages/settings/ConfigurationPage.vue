<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { PageLayout, Card, Badge, Button, Input } from "@friday/portal-ui";
import { api } from "../../composables/useApi.js";
import { refreshModules } from "../../composables/useModules.js";

interface Entry {
  module: string;
  key: string;
  required: boolean;
  description?: string;
  secret: boolean;
  status: "set" | "pending" | "env";
  scope?: string;
  value?: string;
}
type Tab = "config" | "secrets";

const route = useRoute();
const router = useRouter();
const tab = computed<Tab>(() => (route.query.tab === "secrets" ? "secrets" : "config"));
const setTab = (t: Tab) => router.replace({ query: { ...route.query, tab: t } });

const secretsEnabled = ref(true);
const entries = ref<Entry[]>([]);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

/** Draft values keyed by `module/key`; plain entries start from their current value. */
const drafts = reactive<Record<string, string>>({});
const scopes = reactive<Record<string, string>>({});
const editingSecret = ref<string | null>(null);
const id = (e: Entry) => `${e.module}/${e.key}`;

async function load() {
  try {
    const r = await api<{ secretsEnabled: boolean; entries: Entry[] }>("/api/config");
    secretsEnabled.value = r.secretsEnabled;
    entries.value = r.entries;
    for (const e of r.entries) {
      if (!e.secret) drafts[id(e)] = e.value ?? "";
      scopes[id(e)] ??= e.scope === "global" || e.module === "global" ? "global" : e.module;
    }
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(load);
watch(tab, () => { editingSecret.value = null; notice.value = null; });

const visible = computed(() => entries.value.filter((e) => e.secret === (tab.value === "secrets")));
const groups = computed(() => {
  const map = new Map<string, Entry[]>();
  for (const e of visible.value) map.set(e.module, [...(map.get(e.module) ?? []), e]);
  return [...map.entries()].map(([module, items]) => ({ module, items }));
});
const tone = (s: Entry["status"]) => (s === "set" ? "success" : s === "env" ? "accent" : "warning");
/** Saveable when there is a value that differs from what is stored, or when the value only comes from the environment (adopting it into the store). */
const dirty = (e: Entry) => !e.secret && (drafts[id(e)] ?? "") !== "" && (e.status !== "set" || (drafts[id(e)] ?? "") !== (e.value ?? ""));

async function save(e: Entry, reload: boolean) {
  const value = drafts[id(e)] ?? "";
  if (!value) return;
  await run(async () => {
    await api(`/api/config/${encodeURIComponent(scopes[id(e)] ?? e.module)}/${encodeURIComponent(e.key)}`, { method: "PUT", json: { value, secret: e.secret } });
    if (reload && e.module !== "global") {
      const m = await api<{ status: string; error?: string }>(`/api/modules/${e.module}/reload`, { method: "POST" });
      notice.value = m.status === "loaded" ? `${e.module} reloaded` : `${e.module} still ${m.status}: ${m.error ?? ""}`;
      await refreshModules();
    } else {
      notice.value = `${e.key} saved`;
    }
    if (e.secret) { drafts[id(e)] = ""; editingSecret.value = null; }
  });
}

async function clear(e: Entry) {
  if (!e.scope) return;
  await run(async () => {
    await api(`/api/config/${encodeURIComponent(e.scope!)}/${encodeURIComponent(e.key)}`, { method: "DELETE" });
    notice.value = `${e.key} cleared`;
  });
}

const newKey = ref("");
const newValue = ref("");
async function addGlobal() {
  const key = newKey.value.trim();
  if (!key || !newValue.value) return;
  await run(async () => {
    await api(`/api/config/global/${encodeURIComponent(key)}`, { method: "PUT", json: { value: newValue.value, secret: tab.value === "secrets" } });
    notice.value = `${key} saved (global)`;
    newKey.value = "";
    newValue.value = "";
  });
}

async function run(f: () => Promise<void>) {
  busy.value = true;
  try {
    await f();
    await load();
  } catch (e) {
    notice.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PageLayout title="Configuration" subtitle="Values modules declare. Environment values are shown as a fallback and cannot be changed here.">
    <div class="flex gap-1 border-b border-f-border-subtle">
      <button
        v-for="t in [{ id: 'config', label: 'Configuration' }, { id: 'secrets', label: 'Secrets' }] as const"
        :key="t.id"
        class="px-4 py-2 -mb-px border-b-2 text-sm transition"
        :class="tab === t.id ? 'border-f-accent text-f-text-bright' : 'border-transparent text-f-text-muted hover:text-f-text'"
        @click="setTab(t.id)"
      >
        {{ t.label }}
      </button>
    </div>

    <Card v-if="tab === 'secrets' && !secretsEnabled">
      <p class="text-f-warning">
        Secrets are disabled because <code class="font-mono">FRIDAY_MASTER_KEY</code> is not set.
        Generate one with <code class="font-mono">openssl rand -base64 32</code>, add it to the server's secret, and restart. Plain configuration keeps working; secrets come from the environment only until then.
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
            <template v-if="e.secret">
              <Button variant="ghost" :disabled="busy || !secretsEnabled" @click="editingSecret = editingSecret === id(e) ? null : id(e)">{{ e.status === "set" ? "Change" : "Set" }}</Button>
            </template>
            <Button v-if="e.status === 'set'" variant="danger" :disabled="busy" @click="clear(e)">Clear</Button>
          </div>
          <p v-if="e.description" class="text-f-text-muted text-sm">{{ e.description }}</p>

          <!-- Plain: inline, always visible -->
          <form v-if="!e.secret" class="flex flex-wrap items-end gap-3" @submit.prevent="save(e, e.module !== 'global')">
            <div class="flex-1 min-w-48"><Input v-model="drafts[id(e)]" :placeholder="e.status === 'pending' ? 'Not set' : ''" /></div>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-f-text-muted">Scope</span>
              <select v-model="scopes[id(e)]" class="surface-inset px-3 py-2 text-f-text outline-none focus:border-f-accent">
                <option v-if="e.module !== 'global'" :value="e.module">{{ e.module }} only</option>
                <option value="global">global (all modules)</option>
              </select>
            </label>
            <Button v-if="e.module !== 'global'" type="submit" :disabled="busy || !dirty(e)">Save and reload module</Button>
            <Button variant="ghost" :disabled="busy || !dirty(e)" @click="save(e, false)">Save</Button>
          </form>

          <!-- Secret: masked, on demand -->
          <form v-else-if="editingSecret === id(e)" class="surface-inset p-3 flex flex-wrap items-end gap-3" @submit.prevent="save(e, e.module !== 'global')">
            <div class="flex-1 min-w-48"><Input v-model="drafts[id(e)]" type="password" label="Value" placeholder="Enter a new value" /></div>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-f-text-muted">Scope</span>
              <select v-model="scopes[id(e)]" class="surface-inset px-3 py-2 text-f-text outline-none focus:border-f-accent">
                <option v-if="e.module !== 'global'" :value="e.module">{{ e.module }} only</option>
                <option value="global">global (all modules)</option>
              </select>
            </label>
            <Button v-if="e.module !== 'global'" type="submit" :disabled="busy || !drafts[id(e)]">Save and reload module</Button>
            <Button variant="ghost" :disabled="busy || !drafts[id(e)]" @click="save(e, false)">Save</Button>
            <Button variant="ghost" :disabled="busy" @click="editingSecret = null">Cancel</Button>
          </form>
        </li>
      </ul>
    </Card>
    <p v-if="!groups.length && !error" class="text-f-text-muted">No {{ tab === "secrets" ? "secrets" : "configuration values" }} declared.</p>

    <Card :title="tab === 'secrets' ? 'Add a global secret' : 'Add a global value'">
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="addGlobal">
        <div class="min-w-48"><Input v-model="newKey" label="Key" placeholder="MY_SETTING" /></div>
        <div class="flex-1 min-w-48"><Input v-model="newValue" :type="tab === 'secrets' ? 'password' : 'text'" label="Value" /></div>
        <Button type="submit" :disabled="busy || !newKey.trim() || !newValue || (tab === 'secrets' && !secretsEnabled)">Add</Button>
      </form>
      <p class="text-f-text-muted text-sm">Global values apply to every module that reads the key. {{ tab === "secrets" ? "Stored encrypted." : "Stored as plain text." }}</p>
    </Card>
  </PageLayout>
</template>
