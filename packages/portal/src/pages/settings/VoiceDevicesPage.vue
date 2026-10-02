<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { PageLayout, Button, Input, DataTable, StatusDot, Chip, Badge, Drawer, Icon, formatDateTime, type Column } from "@friday/portal-ui";
import { api } from "../../composables/useApi.js";
import type { DeviceRecord, DevicesListing, PendingRecord } from "../../lib/devices.js";

const listing = ref<DevicesListing>({ devices: [], pending: [] });
const error = ref<string | null>(null);
const busy = ref(false);

const deviceColumns: Column[] = [
  { key: "status", label: "", width: "3rem", align: "center" },
  { key: "label", label: "Device" },
  { key: "id", label: "Id", hideBelow: "md" },
  { key: "area", label: "Area" },
  { key: "fingerprint", label: "Fingerprint", hideBelow: "md" },
  { key: "lastSeenAt", label: "Last connected", hideBelow: "lg" },
];
const pendingColumns: Column[] = [
  { key: "id", label: "Id" },
  { key: "fingerprint", label: "Fingerprint" },
  { key: "firstSeenAt", label: "First seen", hideBelow: "lg" },
  { key: "lastSeenAt", label: "Last seen", hideBelow: "md" },
  { key: "attempts", label: "Attempts", align: "right", width: "6rem", hideBelow: "md" },
];

async function load() {
  try { listing.value = await api<DevicesListing>("/api/devices"); error.value = null; }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
onMounted(load);

const when = (s: string | null) => formatDateTime(s, "never");
const tone = (d: DeviceRecord) => (d.revoked ? "error" : d.connected ? "success" : "neutral");
const state = (d: DeviceRecord) => (d.revoked ? "revoked" : d.connected ? "connected" : "idle");

/** Run an API call with the busy flag; errors land in `target` (the page or the open drawer). */
async function run(target: typeof error, fn: () => Promise<unknown>): Promise<boolean> {
  busy.value = true;
  try { await fn(); target.value = null; await load(); return true; }
  catch (e) { target.value = e instanceof Error ? e.message : String(e); return false; }
  finally { busy.value = false; }
}

// ---- accept a pending device -------------------------------------------------
const acceptOpen = ref(false);
const acceptTarget = ref<PendingRecord | null>(null);
const acceptError = ref<string | null>(null);
const form = ref({ label: "", area: "", notes: "" });

function openAccept(p: PendingRecord) {
  acceptTarget.value = p;
  form.value = { label: "", area: "", notes: "" };
  acceptError.value = null;
  acceptOpen.value = true;
}
async function accept() {
  const p = acceptTarget.value;
  if (!p) return;
  const ok = await run(acceptError, () => api(`/api/devices/pending/${encodeURIComponent(p.id)}/accept`, { method: "POST", json: { fingerprint: p.fingerprint, ...form.value } }));
  if (ok) acceptOpen.value = false;
}
const ignore = (p: PendingRecord) => run(error, () => api(`/api/devices/pending/${encodeURIComponent(p.id)}`, { method: "DELETE" }));

// ---- a registered device -------------------------------------------------------
const deviceOpen = ref(false);
const selectedId = ref<string | null>(null);
const selected = computed(() => listing.value.devices.find((d) => d.id === selectedId.value) ?? null);
const deviceError = ref<string | null>(null);
const edit = ref({ label: "", area: "", notes: "" });
const confirmingDelete = ref(false);

function openDevice(d: DeviceRecord) {
  selectedId.value = d.id;
  edit.value = { label: d.label, area: d.area ?? "", notes: d.notes ?? "" };
  deviceError.value = null;
  confirmingDelete.value = false;
  deviceOpen.value = true;
}
const path = () => `/api/devices/${encodeURIComponent(selectedId.value ?? "")}`;
const save = () => run(deviceError, () => api(path(), { method: "PUT", json: edit.value }));
const replaceKey = () => run(deviceError, () => api(`${path()}/replace-key`, { method: "POST", json: { fingerprint: selected.value?.replacement?.fingerprint } }));
const revoke = () => run(deviceError, () => api(`${path()}/revoke`, { method: "POST" }));
async function remove() {
  if (await run(deviceError, () => api(path(), { method: "DELETE" }))) deviceOpen.value = false;
  confirmingDelete.value = false;
}
</script>

<template>
  <PageLayout eyebrow="System" title="Voice devices" subtitle="Satellites that may talk to Friday, and the room each one is in. A newly flashed device appears under Pending after its first attempt to connect.">
    <template #actions>
      <Button variant="ghost" :disabled="busy" @click="load"><Icon name="refresh" />Refresh</Button>
    </template>
    <p v-if="error" class="text-f-error">{{ error }}</p>

    <section v-if="listing.pending.length" class="flex flex-col gap-2">
      <h2 class="text-sm font-medium text-f-text-bright">Pending</h2>
      <p class="text-sm text-f-text-muted">Compare the fingerprint with the one the device shows (in its log, or the Friday key fingerprint sensor in Home Assistant) before accepting.</p>
      <DataTable :columns="pendingColumns" :rows="listing.pending" row-key="id" empty="">
        <template #cell-id="{ value }"><Chip>{{ value }}</Chip></template>
        <template #cell-fingerprint="{ value }"><span class="font-mono text-f-text-bright">{{ value }}</span></template>
        <template #cell-firstSeenAt="{ value }"><span class="text-f-text-muted whitespace-nowrap">{{ when(value as string) }}</span></template>
        <template #cell-lastSeenAt="{ value }"><span class="text-f-text-muted whitespace-nowrap">{{ when(value as string) }}</span></template>
        <template #actions="{ row }">
          <div class="flex justify-end gap-2">
            <Button variant="ghost" :disabled="busy" @click="ignore(row as PendingRecord)">Ignore</Button>
            <Button :disabled="busy" @click="openAccept(row as PendingRecord)">Accept</Button>
          </div>
        </template>
      </DataTable>
    </section>

    <DataTable :columns="deviceColumns" :rows="listing.devices" row-key="id" clickable empty="No voice devices yet" @row-click="openDevice($event as DeviceRecord)">
      <template #cell-status="{ row }"><StatusDot :tone="tone(row as DeviceRecord)" :title="state(row as DeviceRecord)" /></template>
      <template #cell-label="{ row }">
        <span class="text-f-text-bright">{{ (row as DeviceRecord).label }}</span>
        <Badge v-if="(row as DeviceRecord).replacement" class="ml-2">new key</Badge>
      </template>
      <template #cell-id="{ value }"><Chip>{{ value }}</Chip></template>
      <template #cell-area="{ value }"><span v-if="value">{{ value }}</span><span v-else class="text-f-text-muted">–</span></template>
      <template #cell-fingerprint="{ value }"><span class="font-mono text-f-text-muted">{{ value }}</span></template>
      <template #cell-lastSeenAt="{ value }"><span class="text-f-text-muted whitespace-nowrap">{{ when(value as string | null) }}</span></template>
    </DataTable>

    <Drawer v-model:open="acceptOpen" title="Accept device" :subtitle="acceptTarget?.id">
      <template v-if="acceptTarget">
        <p class="text-sm text-f-text-muted">Fingerprint <span class="font-mono text-f-text-bright">{{ acceptTarget.fingerprint }}</span>. It should match the one the device shows.</p>
        <Input v-model="form.label" label="Label" :placeholder="acceptTarget.id" />
        <Input v-model="form.area" label="Area" placeholder="Kitchen" />
        <p class="-mt-2 text-xs text-f-text-muted">The Home Assistant area name, or one of its aliases. Friday uses it when a request names no room.</p>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-f-text-muted">Notes for Friday</span>
          <textarea v-model="form.notes" rows="3" maxlength="1000" placeholder="Next to the TV" class="surface-inset px-3 py-2 text-f-text placeholder:text-f-text-muted outline-none focus:border-f-accent" />
        </label>
        <p v-if="acceptError" class="text-sm text-f-error">{{ acceptError }}</p>
      </template>
      <template #footer>
        <Button variant="ghost" :disabled="busy" @click="acceptOpen = false">Cancel</Button>
        <Button :disabled="busy" @click="accept">Accept</Button>
      </template>
    </Drawer>

    <Drawer v-model:open="deviceOpen" title="Voice device" :subtitle="selected?.id">
      <template v-if="selected">
        <div class="flex flex-wrap items-center gap-2">
          <StatusDot :tone="tone(selected)" :label="state(selected)" />
          <span class="text-sm text-f-text-muted">Last connected {{ when(selected.lastSeenAt) }}</span>
        </div>
        <p class="text-sm text-f-text-muted">Fingerprint <span class="font-mono text-f-text-bright">{{ selected.fingerprint }}</span>, accepted {{ when(selected.createdAt) }}<template v-if="selected.keyReplacedAt">, key replaced {{ when(selected.keyReplacedAt) }}</template>.</p>
        <div v-if="selected.replacement" class="surface-inset p-3 flex flex-col gap-2 text-sm">
          <p class="text-f-warning">This device came back with a different key, last {{ when(selected.replacement.lastSeenAt) }}.</p>
          <p class="text-f-text-muted">Current <span class="font-mono text-f-text">{{ selected.fingerprint }}</span>, new <span class="font-mono text-f-text-bright">{{ selected.replacement.fingerprint }}</span>. Replacing keeps the label, area and notes, and the old key stops working.</p>
          <div><Button :disabled="busy" @click="replaceKey"><Icon name="key" />Replace key</Button></div>
        </div>
        <Input v-model="edit.label" label="Label" />
        <Input v-model="edit.area" label="Area" placeholder="Kitchen" />
        <p class="-mt-2 text-xs text-f-text-muted">The Home Assistant area name, or one of its aliases. Changes apply to the device's next session.</p>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-f-text-muted">Notes for Friday</span>
          <textarea v-model="edit.notes" rows="3" maxlength="1000" class="surface-inset px-3 py-2 text-f-text placeholder:text-f-text-muted outline-none focus:border-f-accent" />
        </label>
        <p v-if="deviceError" class="text-sm text-f-error">{{ deviceError }}</p>
      </template>
      <template #footer>
        <template v-if="confirmingDelete">
          <span class="mr-auto text-sm text-f-text">Delete this device? It can onboard again.</span>
          <Button variant="ghost" :disabled="busy" @click="confirmingDelete = false">Cancel</Button>
          <Button variant="danger" :disabled="busy" @click="remove">Delete</Button>
        </template>
        <template v-else>
          <Button variant="danger" class="mr-auto" :disabled="busy || !selected" @click="confirmingDelete = true">Delete</Button>
          <Button v-if="selected && !selected.revoked" variant="danger" :disabled="busy" @click="revoke">Revoke</Button>
          <Button :disabled="busy || !selected" @click="save">Save</Button>
        </template>
      </template>
    </Drawer>
  </PageLayout>
</template>
