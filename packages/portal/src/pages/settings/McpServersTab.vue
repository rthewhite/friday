<script setup lang="ts">
/** Settings > Configuration > MCP servers: table of stored HTTP MCP servers and an edit drawer (see the secret-management spec). */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Button, Input, DataTable, StatusDot, Drawer, Card, formatDateTime, type Column } from "@friday/portal-ui";
import { api } from "../../composables/useApi.js";
import { refreshModules } from "../../composables/useModules.js";

interface ApiHeader { name: string; secret: boolean; value?: string }
interface Server extends Record<string, unknown> {
  name: string;
  enabled: boolean;
  url: string;
  headers: ApiHeader[];
  include?: string[];
  exclude?: string[];
  scheduling?: "INTERRUPT" | "WHEN_IDLE" | "SILENT";
  prefix?: string;
  status: "loaded" | "failed" | "disabled";
  error?: string;
  tools: string[];
  updatedAt: string;
}
/** A header row in the form. `stored` marks a secret whose value the server keeps. */
interface Row { name: string; value: string; secret: boolean; stored: boolean }

const emit = defineEmits<{ count: [n: number] }>();
const route = useRoute();
const router = useRouter();

const servers = ref<Server[]>([]);
const secretsEnabled = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref<null | "save" | "reconnect" | "delete">(null);

async function load() {
  try {
    const r = await api<{ secretsEnabled: boolean; servers: Server[] }>("/api/mcp/servers");
    secretsEnabled.value = r.secretsEnabled;
    servers.value = r.servers;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
watch(servers, (s) => emit("count", s.length));
onMounted(async () => { await load(); openFromQuery(); });

const columns: Column[] = [
  { key: "status", label: "", width: "3rem", align: "center" },
  { key: "name", label: "Name" },
  { key: "url", label: "URL", hideBelow: "md" },
  { key: "tools", label: "Tools", width: "6rem" },
  { key: "updatedAt", label: "Updated", hideBelow: "lg", width: "11rem" },
];
const tone = (s: Server["status"]) => (s === "loaded" ? "success" : s === "failed" ? "error" : "neutral");

// ---- drawer ---------------------------------------------------------------
const open = ref(false);
const selected = ref<Server | null>(null);
const adding = computed(() => selected.value === null);
const confirmDelete = ref(false);

const blank = () => ({
  name: "",
  enabled: true,
  url: "",
  headers: [] as Row[],
  include: "",
  exclude: "",
  scheduling: "" as "" | NonNullable<Server["scheduling"]>,
  prefix: "",
});
const draft = ref(blank());

const rowsOf = (list: ApiHeader[]): Row[] => list.map((h) => ({ name: h.name, value: h.secret ? "" : (h.value ?? ""), secret: h.secret, stored: h.secret }));
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
/** A stored secret switched to plain has no value to fall back on, so it must be typed in. */
const needsValue = (r: Row) => r.stored && !r.secret && !r.value;

function fill(s: Server) {
  selected.value = s;
  draft.value = {
    name: s.name,
    enabled: s.enabled,
    url: s.url,
    headers: rowsOf(s.headers),
    include: (s.include ?? []).join("\n"),
    exclude: (s.exclude ?? []).join("\n"),
    scheduling: s.scheduling ?? "",
    prefix: s.prefix ?? "",
  };
}
function openServer(s: Server) {
  fill(s);
  confirmDelete.value = false;
  open.value = true;
  router.replace({ query: { ...route.query, server: s.name } });
}
function openAdd() {
  selected.value = null;
  draft.value = blank();
  confirmDelete.value = false;
  open.value = true;
}
function openFromQuery() {
  if (route.query.tab !== "mcp") return;
  const s = servers.value.find((x) => x.name === route.query.server);
  if (s) openServer(s);
}
watch(open, (v) => { if (!v && route.query.server) router.replace({ query: { ...route.query, server: undefined } }); });
watch(() => route.query.server, (n) => { if (n && !open.value) openFromQuery(); });
defineExpose({ openAdd, load });

const addRow = () => draft.value.headers.push({ name: "", value: "", secret: false, stored: false });
const removeRow = (i: number) => draft.value.headers.splice(i, 1);

function body() {
  const d = draft.value;
  return {
    ...(adding.value ? { name: d.name.trim() } : {}),
    enabled: d.enabled,
    url: d.url,
    headers: d.headers
      .filter((r) => r.name.trim())
      .map((r) => (r.secret && r.stored && !r.value ? { name: r.name.trim(), secret: true } : { name: r.name.trim(), value: r.value, secret: r.secret })),
    include: lines(d.include),
    exclude: lines(d.exclude),
    scheduling: d.scheduling || undefined,
    prefix: d.prefix.trim() || undefined,
  };
}

const canSave = computed(() => (adding.value ? draft.value.name.trim() !== "" : true) && draft.value.url.trim() !== "" && !draft.value.headers.some(needsValue));

async function save() {
  await run("save", async () => {
    const s = adding.value
      ? await api<Server>("/api/mcp/servers", { method: "POST", json: body() })
      : await api<Server>(`/api/mcp/servers/${encodeURIComponent(selected.value!.name)}`, { method: "PUT", json: body() });
    after(s, s.status === "failed" ? `${s.name} saved, but it failed to connect` : `${s.name} saved: ${s.status}`);
  });
}
async function reconnect() {
  await run("reconnect", async () => {
    const s = await api<Server>(`/api/mcp/servers/${encodeURIComponent(selected.value!.name)}/reconnect`, { method: "POST" });
    after(s, `${s.name}: ${s.status}`);
  });
}
async function remove() {
  if (!confirmDelete.value) { confirmDelete.value = true; return; }
  const name = selected.value!.name;
  await run("delete", async () => {
    await api(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" });
    notice.value = `${name} deleted`;
    open.value = false;
  });
}
/** Keep the drawer open on the saved server so its status or error is visible. */
function after(s: Server, message: string) {
  notice.value = message;
  fill(s);
  router.replace({ query: { ...route.query, server: s.name } });
}
async function run(kind: NonNullable<typeof busy.value>, f: () => Promise<void>) {
  busy.value = kind;
  try { await f(); await load(); await refreshModules(); } catch (e) { notice.value = e instanceof Error ? e.message : String(e); } finally { busy.value = null; }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <Card v-if="!secretsEnabled">
      <p class="text-f-warning">
        Secrets are disabled because <code class="font-mono">FRIDAY_MASTER_KEY</code> is not set, so tokens cannot be stored. Generate one with <code class="font-mono">openssl rand -base64 32</code>, add it to the server's secret, and restart. Plain headers keep working.
      </p>
    </Card>
    <p v-if="error" class="text-f-error">{{ error }}</p>
    <p v-if="notice && !open" class="text-f-text-muted">{{ notice }}</p>

    <DataTable :columns="columns" :rows="servers" row-key="name" clickable empty="No MCP servers yet" @row-click="openServer">
      <template #cell-status="{ row }"><StatusDot :tone="tone((row as Server).status)" :title="(row as Server).status" /></template>
      <template #cell-name="{ row }"><code class="font-mono text-f-text-bright">{{ (row as Server).name }}</code></template>
      <template #cell-url="{ row }"><span class="font-mono text-xs text-f-text-muted break-all">{{ (row as Server).url }}</span></template>
      <template #cell-tools="{ row }"><span class="text-f-text-muted">{{ (row as Server).tools.length }}</span></template>
      <template #cell-updatedAt="{ row }"><span class="text-f-text-muted whitespace-nowrap">{{ formatDateTime((row as Server).updatedAt) }}</span></template>
    </DataTable>

    <Drawer v-model:open="open" :title="adding ? 'New MCP server' : draft.name" :subtitle="adding ? 'Friday connects to MCP servers over streamable HTTP' : `Tools are registered as ${draft.prefix || draft.name}__<tool>`">
      <div v-if="selected" class="flex flex-wrap items-center gap-2 text-sm">
        <StatusDot :tone="tone(selected.status)" :label="selected.status" />
        <span class="text-f-text-muted">{{ selected.tools.length }} tools</span>
      </div>
      <p v-if="selected?.error" class="surface-inset px-3 py-2 font-mono text-xs text-f-error break-words">{{ selected.error }}</p>
      <p v-if="notice && open" class="text-sm text-f-text-muted">{{ notice }}</p>

      <Input v-if="adding" v-model="draft.name" label="Name" placeholder="home" />
      <label class="flex items-center gap-2 text-sm">
        <input v-model="draft.enabled" type="checkbox" class="accent-f-accent" />
        <span>Enabled</span>
      </label>
      <Input v-model="draft.url" label="URL" placeholder="https://homeassistant.local:8123/api/mcp" />

      <div class="flex flex-col gap-2 text-sm">
        <div class="flex items-center justify-between">
          <span class="text-f-text-muted">Headers</span>
          <Button variant="ghost" @click="addRow"><Icon name="plus" />Add</Button>
        </div>
        <div v-for="(row, i) in draft.headers" :key="i" class="flex items-center gap-2">
          <input v-model="row.name" placeholder="Authorization" :disabled="row.stored" class="surface-inset w-2/5 px-3 py-2 font-mono text-f-text outline-none focus:border-f-accent disabled:opacity-70" />
          <input
            v-model="row.value"
            :type="row.secret ? 'password' : 'text'"
            :placeholder="needsValue(row) ? 'enter a value to replace the stored secret' : row.stored && row.secret ? '•••••• stored, leave blank to keep' : row.secret ? 'secret value' : 'value'"
            :disabled="row.secret && !secretsEnabled"
            autocomplete="off"
            class="surface-inset min-w-0 flex-1 px-3 py-2 font-mono text-f-text placeholder:text-f-text-muted outline-none focus:border-f-accent disabled:opacity-50"
          />
          <label class="flex items-center gap-1 text-xs text-f-text-muted" :title="secretsEnabled ? 'Store encrypted; never shown again' : 'Needs FRIDAY_MASTER_KEY'">
            <input v-model="row.secret" type="checkbox" :disabled="!secretsEnabled && !row.secret" class="accent-f-accent" />secret
          </label>
          <Button variant="ghost" :title="`Remove ${row.name}`" @click="removeRow(i)"><Icon name="close" /></Button>
        </div>
        <p v-if="!draft.headers.length" class="text-xs text-f-text-muted">Add an Authorization header for bearer tokens and mark it secret.</p>
      </div>

      <label class="flex flex-col gap-1 text-sm">
        <span class="text-f-text-muted">Only these tools (one per line, empty = all)</span>
        <textarea v-model="draft.include" rows="2" class="surface-inset px-3 py-2 font-mono text-f-text outline-none focus:border-f-accent"></textarea>
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-f-text-muted">Skip these tools (one per line)</span>
        <textarea v-model="draft.exclude" rows="2" class="surface-inset px-3 py-2 font-mono text-f-text outline-none focus:border-f-accent"></textarea>
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-f-text-muted">Scheduling of results</span>
        <select v-model="draft.scheduling" class="surface-inset px-3 py-2 text-f-text outline-none focus:border-f-accent">
          <option value="">default (INTERRUPT)</option>
          <option value="INTERRUPT">INTERRUPT: answer right away</option>
          <option value="WHEN_IDLE">WHEN_IDLE: after the current turn</option>
          <option value="SILENT">SILENT: don't announce</option>
        </select>
      </label>
      <Input v-model="draft.prefix" label="Tool name prefix" :placeholder="draft.name || 'defaults to the name'" />

      <template #footer>
        <Button v-if="selected" variant="danger" :disabled="busy !== null" @click="remove">{{ busy === "delete" ? "Deleting…" : confirmDelete ? "Confirm delete" : "Delete" }}</Button>
        <span class="flex-1"></span>
        <Button v-if="selected?.enabled" variant="ghost" :disabled="busy !== null" @click="reconnect">{{ busy === "reconnect" ? "Connecting…" : "Reconnect" }}</Button>
        <Button :disabled="busy !== null || !canSave" @click="save">{{ busy === "save" ? "Connecting…" : "Save" }}</Button>
      </template>
    </Drawer>
  </div>
</template>

<script lang="ts">
import { Icon } from "@friday/portal-ui";
export default { components: { Icon } };
</script>
