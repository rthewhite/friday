<script setup lang="ts">
/** Settings > Connections: OAuth connections, the modules requesting them, grants and the login (see the oauth-connections spec). */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { PageLayout, Button, Input, DataTable, StatusDot, Chip, Drawer, Card, Icon, formatDateTime, type Column } from "@friday/portal-ui";
import { api } from "../../composables/useApi.js";

type State = "connected" | "disconnected" | "error";
interface Requester { module: string; scopes: string[]; description?: string; granted: boolean }
interface Connection extends Record<string, unknown> {
  provider: string;
  name: string;
  configured: boolean;
  generic: boolean;
  clientId?: string;
  hasClientSecret: boolean;
  authUrl?: string;
  tokenUrl?: string;
  extraScopes: string[];
  requestedScopes: string[];
  grantedScopes?: string[];
  missingScopes: { scope: string; modules: string[] }[];
  requesters: Requester[];
  state?: State;
  error?: string;
  expiresAt?: string;
  redirectUri: string;
  updatedAt?: string;
}
interface Provider { id: string; name: string; pkce: boolean; refresh: boolean }

const route = useRoute();
const router = useRouter();

const connections = ref<Connection[]>([]);
const providers = ref<Provider[]>([]);
const secretsEnabled = ref(true);
const error = ref<string | null>(null);
const busy = ref<null | "save" | "connect" | "delete" | "grant">(null);

async function load() {
  try {
    const r = await api<{ secretsEnabled: boolean; connections: Connection[] }>("/api/oauth/connections");
    secretsEnabled.value = r.secretsEnabled;
    connections.value = r.connections;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(async () => {
  await Promise.all([load(), api<Provider[]>("/api/oauth/providers").then((p) => (providers.value = p)).catch(() => {})]);
  openFromQuery();
});

const columns: Column[] = [
  { key: "status", label: "", width: "3rem", align: "center" },
  { key: "name", label: "Provider" },
  { key: "requesters", label: "Requested by" },
  { key: "scopes", label: "Scopes", hideBelow: "md" },
  { key: "updatedAt", label: "Updated", hideBelow: "lg", width: "11rem" },
];
const statusOf = (c: Connection) => (!c.configured ? "not set up" : c.state === "connected" && c.missingScopes.length ? "needs reconnect" : c.state!);
const tone = (c: Connection) => {
  if (!c.configured) return "neutral" as const;
  if (c.state === "error") return "error" as const;
  if (c.state === "connected") return c.missingScopes.length ? ("warning" as const) : ("success" as const);
  return "warning" as const;
};
const scopesSummary = (c: Connection) => {
  if (c.missingScopes.length) return `${c.missingScopes.length} missing, reconnect`;
  if (c.grantedScopes) return `${c.grantedScopes.length} granted`;
  return c.requestedScopes.length ? `${c.requestedScopes.length} requested` : "none";
};

// ---- drawer ---------------------------------------------------------------
const open = ref(false);
/** The entry being edited; null for a connection to a provider no module requests. */
const selected = ref<Connection | null>(null);
const confirmDelete = ref(false);
const notice = ref<string | null>(null);
const copied = ref(false);

const blank = () => ({ provider: "", genericId: "", clientId: "", clientSecret: "", authUrl: "", tokenUrl: "", extraScopes: "" });
const draft = ref(blank());

const isGeneric = computed(() => (selected.value ? selected.value.generic : draft.value.provider === "generic"));
/** The connection's provider id: the entry's, the chosen catalogue provider, or the id typed for a generic one. */
const providerId = computed(() => selected.value?.provider ?? (draft.value.provider === "generic" ? draft.value.genericId.trim() : draft.value.provider));
const configured = computed(() => selected.value?.configured === true);
/** Redirect URIs share one base; take it from the listing (it honours FRIDAY_PUBLIC_URL), else this page's origin. */
const redirectBase = computed(() => {
  const any = connections.value[0];
  return any ? any.redirectUri.replace(/\/api\/oauth\/[^/]+\/callback$/, "") : location.origin;
});
const redirectUri = computed(() => (providerId.value ? `${redirectBase.value}/api/oauth/${encodeURIComponent(providerId.value)}/callback` : ""));
const hasTokens = computed(() => selected.value?.state === "connected" || selected.value?.grantedScopes !== undefined);

function fill(c: Connection | null) {
  selected.value = c;
  draft.value = c
    ? { provider: c.generic ? "generic" : c.provider, genericId: c.generic ? c.provider : "", clientId: c.clientId ?? "", clientSecret: "", authUrl: c.authUrl ?? "", tokenUrl: c.tokenUrl ?? "", extraScopes: c.extraScopes.join(" ") }
    : blank();
}
function openConnection(c: Connection) {
  fill(c);
  confirmDelete.value = false;
  copied.value = false;
  notice.value = null;
  open.value = true;
  router.replace({ query: { provider: c.provider } });
}
function openNew() {
  fill(null);
  confirmDelete.value = false;
  copied.value = false;
  notice.value = null;
  open.value = true;
}
/** `?provider=` opens that drawer; `connected=1` or `error=` (the login coming back) is shown once and dropped. */
function openFromQuery() {
  const id = route.query.provider;
  if (typeof id !== "string") return;
  const c = connections.value.find((x) => x.provider === id);
  if (!c) return;
  openConnection(c);
  if (route.query.connected === "1") notice.value = `${c.name} connected`;
  else if (typeof route.query.error === "string") notice.value = route.query.error;
}
watch(open, (v) => { if (!v && route.query.provider) router.replace({ query: {} }); });

const scopesOf = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const dirty = computed(() => {
  const c = selected.value;
  const d = draft.value;
  if (!c?.configured) return true;
  return d.clientId.trim() !== (c.clientId ?? "") || d.clientSecret !== "" || scopesOf(d.extraScopes).join(" ") !== c.extraScopes.join(" ")
    || (c.generic && (d.authUrl.trim() !== (c.authUrl ?? "") || d.tokenUrl.trim() !== (c.tokenUrl ?? "")));
});
const canSave = computed(() =>
  secretsEnabled.value && providerId.value !== "" && draft.value.clientId.trim() !== ""
  && (!isGeneric.value || (draft.value.authUrl.trim() !== "" && draft.value.tokenUrl.trim() !== "")));

function body() {
  const d = draft.value;
  return {
    clientId: d.clientId.trim(),
    ...(d.clientSecret ? { clientSecret: d.clientSecret } : {}),
    extraScopes: scopesOf(d.extraScopes),
    ...(isGeneric.value ? { authUrl: d.authUrl.trim(), tokenUrl: d.tokenUrl.trim() } : {}),
  };
}

async function save(): Promise<Connection | undefined> {
  let saved: Connection | undefined;
  await run("save", async () => {
    saved = await api<Connection>(`/api/oauth/connections/${encodeURIComponent(providerId.value)}`, { method: "PUT", json: body() });
    notice.value = saved.state === "disconnected" && saved.requesters.some((r) => r.granted) ? `${saved.name} saved; connect it to log in` : `${saved.name} saved`;
  });
  if (saved) {
    fill(connections.value.find((c) => c.provider === saved!.provider) ?? saved);
    router.replace({ query: { provider: saved.provider } });
  }
  return saved;
}
/** Saves unsaved fields first, then leaves for the provider's login; the callback brings the browser back here. */
async function connect() {
  if (dirty.value && !(await save())) return;
  busy.value = "connect";
  location.assign(`/api/oauth/${encodeURIComponent(providerId.value)}/authorize`);
}
async function toggleGrant(r: Requester) {
  const c = selected.value!;
  await run("grant", async () => {
    await api(`/api/oauth/connections/${encodeURIComponent(c.provider)}/grants/${encodeURIComponent(r.module)}`, { method: r.granted ? "DELETE" : "PUT" });
    notice.value = r.granted ? `${r.module} no longer gets the ${c.name} token` : `${r.module} granted`;
  });
  const fresh = connections.value.find((x) => x.provider === c.provider);
  if (fresh) fill(fresh);
}
async function remove() {
  if (!confirmDelete.value) { confirmDelete.value = true; return; }
  const c = selected.value!;
  await run("delete", async () => {
    await api(`/api/oauth/connections/${encodeURIComponent(c.provider)}`, { method: "DELETE" });
    open.value = false;
  });
}
async function copy() {
  await navigator.clipboard.writeText(redirectUri.value);
  copied.value = true;
}
async function run(kind: NonNullable<typeof busy.value>, f: () => Promise<void>) {
  busy.value = kind;
  try { await f(); await load(); } catch (e) { notice.value = e instanceof Error ? e.message : String(e); } finally { busy.value = null; }
}

const catalogue = computed(() => providers.value);
const connectLabel = computed(() => (busy.value === "connect" ? "Opening…" : hasTokens.value || selected.value?.missingScopes.length ? "Reconnect" : "Connect"));
const expires = (c: Connection) => (c.expiresAt ? `token valid until ${formatDateTime(c.expiresAt)}` : "");
</script>

<template>
  <PageLayout eyebrow="System" title="Connections" subtitle="OAuth logins Friday keeps for modules. A module gets a provider's token only when you grant it here.">
    <template #actions>
      <Button variant="ghost" :disabled="busy !== null" @click="load"><Icon name="refresh" />Refresh</Button>
      <Button :disabled="!secretsEnabled" @click="openNew"><Icon name="plus" />New connection</Button>
    </template>
    <Card v-if="!secretsEnabled">
      <p class="text-f-warning">
        Connections are disabled because <code class="font-mono">FRIDAY_MASTER_KEY</code> is not set, so client secrets and tokens cannot be stored. Generate one with <code class="font-mono">openssl rand -base64 32</code>, add it to the server's secret, and restart.
      </p>
    </Card>
    <p v-if="error" class="text-f-error">{{ error }}</p>

    <DataTable :columns="columns" :rows="connections" row-key="provider" clickable empty="No module requests a connection yet" @row-click="openConnection">
      <template #cell-status="{ row }"><StatusDot :tone="tone(row as Connection)" :title="statusOf(row as Connection)" /></template>
      <template #cell-name="{ row }">
        <span class="text-f-text-bright">{{ (row as Connection).name }}</span>
        <span v-if="(row as Connection).generic" class="ml-2 text-xs text-f-text-muted">generic</span>
      </template>
      <template #cell-requesters="{ row }">
        <span class="flex flex-wrap gap-1">
          <Chip v-for="r in (row as Connection).requesters" :key="r.module" :title="r.granted ? 'granted' : 'not granted'">{{ r.granted ? "✓ " : "" }}{{ r.module }}</Chip>
          <span v-if="!(row as Connection).requesters.length" class="text-xs text-f-text-muted">no module</span>
        </span>
      </template>
      <template #cell-scopes="{ row }">
        <span :class="(row as Connection).missingScopes.length ? 'text-f-warning' : 'text-f-text-muted'">{{ scopesSummary(row as Connection) }}</span>
      </template>
      <template #cell-updatedAt="{ row }"><span class="text-f-text-muted whitespace-nowrap">{{ formatDateTime((row as Connection).updatedAt, "") }}</span></template>
    </DataTable>

    <Drawer v-model:open="open" :title="selected ? selected.name : 'New connection'" :subtitle="selected ? `Requested by ${selected.requesters.map((r) => r.module).join(', ') || 'no module'}` : 'Connect a provider no module asks for yet'">
      <div v-if="selected" class="flex flex-wrap items-center gap-2 text-sm">
        <StatusDot :tone="tone(selected)" :label="statusOf(selected)" />
        <span class="text-f-text-muted">{{ expires(selected) }}</span>
      </div>
      <p v-if="selected?.error" class="surface-inset px-3 py-2 font-mono text-xs text-f-error break-words">{{ selected.error }}</p>
      <p v-if="notice" class="text-sm text-f-text-muted">{{ notice }}</p>

      <label v-if="!configured" class="flex flex-col gap-1 text-sm">
        <span class="text-f-text-muted">Provider</span>
        <select v-model="draft.provider" :disabled="selected !== null" class="surface-inset px-3 py-2 text-f-text outline-none focus:border-f-accent disabled:opacity-70">
          <option value="" disabled>Choose a provider</option>
          <option v-for="p in catalogue" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <Input v-if="!selected && draft.provider === 'generic'" v-model="draft.genericId" label="Provider id (kebab-case)" placeholder="acme" />
      <template v-if="isGeneric">
        <Input v-model="draft.authUrl" label="Authorization URL" placeholder="https://provider.example/oauth/authorize" />
        <Input v-model="draft.tokenUrl" label="Token URL" placeholder="https://provider.example/oauth/token" />
      </template>

      <Input v-model="draft.clientId" label="Client id" />
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-f-text-muted">Client secret</span>
        <input
          v-model="draft.clientSecret"
          type="password"
          autocomplete="off"
          :placeholder="selected?.hasClientSecret ? '•••••• stored, leave blank to keep' : 'client secret (leave empty for public clients)'"
          :disabled="!secretsEnabled"
          class="surface-inset px-3 py-2 font-mono text-f-text placeholder:text-f-text-muted outline-none focus:border-f-accent disabled:opacity-50"
        />
      </label>

      <div v-if="redirectUri" class="flex flex-col gap-1 text-sm">
        <span class="text-f-text-muted">Redirect URI (register this with the provider)</span>
        <div class="surface-inset p-2 flex flex-wrap items-center gap-2">
          <code class="font-mono text-xs text-f-text-bright break-all flex-1">{{ redirectUri }}</code>
          <Button variant="ghost" @click="copy">{{ copied ? "Copied" : "Copy" }}</Button>
        </div>
      </div>

      <Input v-model="draft.extraScopes" label="Extra scopes (space separated, on top of what granted modules ask for)" />

      <div v-if="selected?.requesters.length" class="flex flex-col gap-2 text-sm">
        <span class="text-f-text-muted">Modules</span>
        <label v-for="r in selected.requesters" :key="r.module" class="surface-inset flex items-start gap-3 px-3 py-2" :class="configured ? '' : 'opacity-60'">
          <input type="checkbox" class="mt-1 accent-f-accent" :checked="r.granted" :disabled="!configured || busy !== null" @change="toggleGrant(r)" />
          <span class="flex flex-col gap-1">
            <span><Chip>{{ r.module }}</Chip><span v-if="r.description" class="ml-2 text-f-text">{{ r.description }}</span></span>
            <span class="font-mono text-xs text-f-text-muted">{{ r.scopes.join(" ") || "no scopes" }}</span>
          </span>
        </label>
        <p v-if="!configured" class="text-xs text-f-text-muted">Save the connection first, then grant the modules that may use it.</p>
      </div>

      <div v-if="selected?.missingScopes.length" class="surface-inset px-3 py-2 text-sm">
        <p class="text-f-warning">The stored login lacks these scopes. Reconnect to grant them:</p>
        <ul class="mt-1 font-mono text-xs">
          <li v-for="m in selected.missingScopes" :key="m.scope">{{ m.scope }} <span class="text-f-text-muted">({{ m.modules.length ? m.modules.join(", ") : "extra scope" }})</span></li>
        </ul>
      </div>

      <template #footer>
        <Button v-if="configured" variant="danger" :disabled="busy !== null" @click="remove">{{ busy === "delete" ? "Deleting…" : confirmDelete ? "Confirm delete" : "Delete" }}</Button>
        <span class="flex-1"></span>
        <Button v-if="configured || canSave" variant="ghost" :disabled="busy !== null || !canSave || !secretsEnabled" @click="connect">{{ connectLabel }}</Button>
        <Button :disabled="busy !== null || !canSave || !dirty" @click="save">{{ busy === "save" ? "Saving…" : "Save" }}</Button>
      </template>
    </Drawer>
  </PageLayout>
</template>
