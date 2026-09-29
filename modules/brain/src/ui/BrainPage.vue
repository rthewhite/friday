<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Badge, Button, Card, DataTable, Drawer, Icon, Input, PageLayout, formatDateTime, type Column } from "@friday/portal-ui";
import { ApiError, PAGE_TYPES, api, hint, matches, parseAliases, type PageList, type PageSummary, type PageType } from "./lib/pages.js";

const route = useRoute();
const router = useRouter();

const data = ref<PageList | null>(null);
const error = ref("");
const query = ref("");
const loading = ref(false);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await api<PageList>("GET", "pages");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const profile = computed(() => data.value?.pages.find((p) => p.isProfile));
const rows = computed(() =>
  (data.value?.pages ?? [])
    .filter((p) => !p.isProfile && matches(p, query.value))
    .map((p) => ({ ...p, hint: hint(p.body), aliasList: p.aliases.join(", ") })),
);
const columns: Column[] = [
  { key: "name", label: "Name" },
  { key: "type", label: "Type" },
  { key: "aliasList", label: "Aliases", hideBelow: "md" },
  { key: "hint", label: "Hint", hideBelow: "lg" },
  { key: "updatedAt", label: "Updated", hideBelow: "md" },
];
const budgetPct = computed(() => {
  const p = data.value?.profile;
  return p ? Math.min(100, Math.round((p.usedTokens / Math.max(1, p.budgetTokens)) * 100)) : 0;
});

const open = (id: string) => router.push(`/m/brain/p/${encodeURIComponent(id)}`);

// ---- New page ----
const creating = ref(false);
const draft = ref<{ name: string; type: PageType; aliases: string }>({ name: "", type: "other", aliases: "" });
const createError = ref("");
function startCreate(name = "") {
  draft.value = { name, type: "other", aliases: "" };
  createError.value = "";
  creating.value = true;
}
async function create() {
  createError.value = "";
  try {
    const page = await api<PageSummary>("POST", "pages", { name: draft.value.name, type: draft.value.type, aliases: parseAliases(draft.value.aliases), body: "" });
    creating.value = false;
    await open(page.id);
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e);
  }
}
// A dangling [[link]] on a page opens this list with ?new=<name>.
watch(
  () => route.query.new,
  (name) => {
    if (typeof name !== "string") return;
    startCreate(name);
    void router.replace({ query: { ...route.query, new: undefined } });
  },
  { immediate: true },
);

// ---- Recently deleted ----
const showDeleted = ref(false);
const deletedError = ref("");
const notice = ref("");
async function undelete(id: string) {
  deletedError.value = "";
  try {
    await api("POST", `pages/${encodeURIComponent(id)}/undelete`);
    await load();
  } catch (e) {
    deletedError.value = e instanceof ApiError && e.code === "name_taken" ? `Can't restore: ${e.message}` : e instanceof Error ? e.message : String(e);
  }
}
const purging = ref<{ id: string; name: string } | null>(null);
const purgeOpen = ref(false);
const confirmText = ref("");
const purgeError = ref("");
function startPurge(p: { id: string; name: string }) {
  purging.value = p;
  confirmText.value = "";
  purgeError.value = "";
  purgeOpen.value = true;
}
async function purge() {
  if (!purging.value) return;
  purgeError.value = "";
  try {
    const { unlinked } = await api<{ unlinked: string[] }>("POST", `pages/${encodeURIComponent(purging.value.id)}/purge`, { confirm: confirmText.value });
    notice.value = `${purging.value.name} is forgotten.${unlinked.length ? ` Links to it were turned into plain text on: ${unlinked.join(", ")}.` : ""}`;
    purgeOpen.value = false;
    await load();
  } catch (e) {
    purgeError.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <PageLayout eyebrow="Modules" title="Brain" subtitle="What Friday remembers about you, your household and the people, places and projects in your life">
    <template #actions>
      <Button variant="ghost" :disabled="loading" @click="load()"><Icon name="refresh" />Refresh</Button>
      <Button @click="startCreate()"><Icon name="plus" />New page</Button>
    </template>
    <p v-if="error" class="text-f-error">{{ error }}</p>
    <p v-if="notice" class="text-f-success">{{ notice }}</p>

    <Card v-if="data && profile">
      <button type="button" class="flex w-full flex-col gap-2 text-left" @click="open(profile.id)">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-base font-semibold text-f-text-bright">Profile</span>
          <Badge tone="accent">pinned</Badge>
          <Badge v-if="data.profile.overBudget" tone="warning">over budget</Badge>
          <span class="ml-auto text-sm text-f-text-muted">~{{ data.profile.usedTokens }} / {{ data.profile.budgetTokens }} tokens</span>
        </div>
        <div class="h-1.5 w-full overflow-hidden rounded-full bg-f-bg" role="meter" :aria-valuenow="data.profile.usedTokens" :aria-valuemax="data.profile.budgetTokens" aria-label="Profile budget">
          <div :class="['h-full rounded-full', data.profile.overBudget ? 'bg-f-warning' : 'bg-f-accent']" :style="{ width: `${budgetPct}%` }" />
        </div>
        <p class="text-sm text-f-text-muted line-clamp-2">{{ hint(profile.body) || "Empty. Friday adds facts about you and your household here." }}</p>
      </button>
    </Card>

    <Input v-model="query" label="Search" placeholder="Name, alias or text" />
    <DataTable :columns="columns" :rows="rows" row-key="id" clickable :empty="query ? 'No page matches' : 'No pages yet'" @row-click="open(($event as PageSummary).id)">
      <template #cell-name="{ value }"><span class="font-medium text-f-text-bright">{{ value }}</span></template>
      <template #cell-type="{ value }"><Badge>{{ value }}</Badge></template>
      <template #cell-aliasList="{ value }"><span class="text-f-text-muted">{{ value }}</span></template>
      <template #cell-hint="{ value }"><span class="line-clamp-1 text-f-text-muted">{{ value }}</span></template>
      <template #cell-updatedAt="{ value }"><span class="whitespace-nowrap text-f-text-muted">{{ formatDateTime(value as string) }}</span></template>
    </DataTable>

    <Card v-if="data?.deleted.length">
      <template #header>
        <button type="button" class="flex w-full items-center gap-2 text-left text-sm font-semibold text-f-text-bright" :aria-expanded="showDeleted" @click="showDeleted = !showDeleted">
          <Icon name="chevron" :class="['transition', showDeleted && 'rotate-90']" />Recently deleted<span class="text-f-text-muted font-normal">{{ data.deleted.length }}</span>
        </button>
      </template>
      <template v-if="showDeleted">
        <p v-if="deletedError" class="text-sm text-f-error">{{ deletedError }}</p>
        <ul class="flex flex-col divide-y divide-f-border-subtle">
          <li v-for="d in data.deleted" :key="d.id" class="flex flex-wrap items-center gap-2 py-2">
            <button type="button" class="font-medium text-f-text-bright hover:underline" @click="open(d.id)">{{ d.name }}</button>
            <span class="text-sm text-f-text-muted">deleted {{ formatDateTime(d.deletedAt) }}</span>
            <span class="ml-auto flex gap-2">
              <Button variant="ghost" @click="undelete(d.id)">Restore</Button>
              <Button variant="danger" @click="startPurge(d)">Delete forever</Button>
            </span>
          </li>
        </ul>
      </template>
    </Card>

    <Drawer v-model:open="creating" title="New page" subtitle="A person, place or project Friday should know about">
      <form id="brain-new" class="flex flex-col gap-4" @submit.prevent="create">
        <Input v-model="draft.name" label="Name" placeholder="Anouk" />
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-f-text-muted">Type</span>
          <select v-model="draft.type" class="surface-inset px-3 py-2 text-f-text outline-none focus:border-f-accent">
            <option v-for="t in PAGE_TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <Input v-model="draft.aliases" label="Aliases (comma-separated)" placeholder="Noukie, my sister" />
        <p v-if="createError" class="text-sm text-f-error">{{ createError }}</p>
      </form>
      <template #footer>
        <Button variant="ghost" @click="creating = false">Cancel</Button>
        <Button type="submit" form="brain-new" :disabled="!draft.name.trim()">Create</Button>
      </template>
    </Drawer>

    <Drawer v-model:open="purgeOpen" title="Delete forever" :subtitle="purging?.name">
      <p class="text-sm text-f-text">
        This removes the page and its whole history, and Friday won't create a page with this name again on its own.
        Links to it on other pages become plain text. Conversation transcripts and older revisions of other pages may still mention it.
      </p>
      <form id="brain-purge" @submit.prevent="purge">
        <Input v-model="confirmText" :label="`Type ${purging?.name ?? ''} to confirm`" />
      </form>
      <p v-if="purgeError" class="text-sm text-f-error">{{ purgeError }}</p>
      <template #footer>
        <Button variant="ghost" @click="purgeOpen = false">Cancel</Button>
        <Button type="submit" form="brain-purge" variant="danger" :disabled="confirmText !== purging?.name">Delete forever</Button>
      </template>
    </Drawer>
  </PageLayout>
</template>
