<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { PageLayout, Button, DataTable, StatusDot, Badge, Drawer, Icon, formatDateTime, type Column } from "@friday/portal-ui";
import { api } from "../../composables/useApi.js";
import { useSession } from "../../composables/useSession.js";
import { actionFor, sortUsers, statusTone, type UserEntry } from "../../lib/users.js";

const { me } = useSession();
const users = ref<UserEntry[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);
const open = ref(false);
const selected = ref<UserEntry | null>(null);
const confirming = ref(false);
const drawerError = ref<string | null>(null);

const columns: Column[] = [
  { key: "status", label: "", width: "3rem", align: "center" },
  { key: "name", label: "Name" },
  { key: "email", label: "Email", hideBelow: "md" },
  { key: "role", label: "Role" },
  { key: "firstLoginAt", label: "First login", hideBelow: "lg" },
  { key: "lastLoginAt", label: "Last login", hideBelow: "md" },
];

async function load() {
  try {
    users.value = sortUsers((await api<{ users: UserEntry[] }>("/api/users")).users);
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(load);

function openUser(u: UserEntry) {
  selected.value = u;
  confirming.value = false;
  drawerError.value = null;
  open.value = true;
}

const action = computed(() => (selected.value ? actionFor(selected.value, me.value?.id) : null));

async function setDisabled(disabled: boolean) {
  if (!selected.value) return;
  busy.value = true;
  drawerError.value = null;
  try {
    selected.value = await api<UserEntry>(`/api/users/${encodeURIComponent(selected.value.id)}/${disabled ? "disable" : "enable"}`, { method: "POST" });
    confirming.value = false;
    await load();
  } catch (e) {
    drawerError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

const when = (s: string | null) => formatDateTime(s, "never");
</script>

<template>
  <PageLayout eyebrow="System" title="Users" subtitle="Everyone who has logged in to Friday.">
    <template #actions>
      <Button variant="ghost" :disabled="busy" @click="load"><Icon name="refresh" />Refresh</Button>
    </template>
    <p class="text-sm text-f-text-muted">
      A user appears here after their first login. Who may log in, and who is an admin, is decided by the Friday groups in Authentik;
      a change there applies at the user's next login, or within a day. Disabling someone here locks them out at once.
    </p>
    <p v-if="error" class="text-f-error">{{ error }}</p>

    <DataTable :columns="columns" :rows="users" row-key="id" clickable empty="Nobody has logged in yet" @row-click="openUser($event as UserEntry)">
      <template #cell-status="{ row }"><StatusDot :tone="statusTone(row as UserEntry)" :title="(row as UserEntry).disabled ? 'disabled' : 'active'" /></template>
      <template #cell-name="{ row }">
        <span class="text-f-text-bright">{{ (row as UserEntry).name }}</span>
        <Badge v-if="(row as UserEntry).owner" tone="accent" class="ml-2">owner</Badge>
        <Badge v-if="(row as UserEntry).id === me?.id" class="ml-2">you</Badge>
      </template>
      <template #cell-email="{ value }"><span class="text-f-text-muted">{{ value ?? "" }}</span></template>
      <template #cell-role="{ value }">{{ value === "admin" ? "Admin" : "Member" }}</template>
      <template #cell-firstLoginAt="{ value }"><span class="text-f-text-muted whitespace-nowrap">{{ when(value as string) }}</span></template>
      <template #cell-lastLoginAt="{ value }"><span class="text-f-text-muted whitespace-nowrap">{{ when(value as string) }}</span></template>
    </DataTable>

    <Drawer v-model:open="open" title="User" :subtitle="selected?.email ?? selected?.id">
      <template v-if="selected">
        <div class="flex flex-wrap items-center gap-2">
          <StatusDot :tone="statusTone(selected)" :label="selected.disabled ? 'Disabled' : 'Active'" />
          <span class="text-f-text-bright">{{ selected.name }}</span>
          <Badge v-if="selected.owner" tone="accent">owner</Badge>
        </div>
        <p class="text-sm text-f-text-muted">
          {{ selected.role === "admin" ? "Admin" : "Member" }}. First logged in {{ when(selected.firstLoginAt) }}, last {{ when(selected.lastLoginAt) }}.
        </p>
        <p v-if="selected.disabled" class="text-sm text-f-text-muted">A disabled user can't log in and has no sessions. Enabling lets them log in again.</p>
        <p v-else-if="!action" class="text-sm text-f-text-muted">{{ selected.id === me?.id ? "You can't disable yourself." : "The dev user can't be disabled." }}</p>
        <p v-if="drawerError" class="text-sm text-f-error">{{ drawerError }}</p>
      </template>
      <template #footer>
        <template v-if="confirming">
          <span class="mr-auto text-sm text-f-text">Disable {{ selected?.name }}? Their sessions end now.</span>
          <Button variant="ghost" :disabled="busy" @click="confirming = false">Cancel</Button>
          <Button variant="danger" :disabled="busy" @click="setDisabled(true)">Disable</Button>
        </template>
        <template v-else>
          <Button v-if="action === 'disable'" variant="danger" class="mr-auto" :disabled="busy" @click="confirming = true">Disable</Button>
          <Button v-if="action === 'enable'" class="mr-auto" :disabled="busy" @click="setDisabled(false)">Enable</Button>
        </template>
      </template>
    </Drawer>
  </PageLayout>
</template>
