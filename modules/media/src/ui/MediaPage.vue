<script setup lang="ts">
import { ref } from "vue";
import { PageLayout, Card, Input, Button, DataTable, Badge } from "@friday/portal-ui";

interface Item {
  id: string;
  type?: string;
  title: string;
  series?: string;
  season?: number;
  episode?: number;
  year?: number;
  watched?: boolean;
  unplayed_episodes?: number;
  [k: string]: unknown;
}

const query = ref("");
const type = ref<"any" | "series" | "movie">("any");
const results = ref<Item[]>([]);
const busy = ref(false);
const message = ref<{ tone: "success" | "error"; text: string } | null>(null);

const columns = [
  { key: "title", label: "Title" },
  { key: "type", label: "Type" },
  { key: "year", label: "Year" },
  { key: "state", label: "State" },
];

async function search() {
  if (!query.value.trim()) return;
  busy.value = true;
  message.value = null;
  try {
    const res = await fetch(`/api/modules/media/search?q=${encodeURIComponent(query.value)}&type=${type.value}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    results.value = body.results;
  } catch (e) {
    message.value = { tone: "error", text: e instanceof Error ? e.message : String(e) };
  } finally {
    busy.value = false;
  }
}

async function play(item: Item) {
  busy.value = true;
  message.value = null;
  try {
    const res = await fetch("/api/modules/media/play", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ item_id: item.id }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    message.value = { tone: "success", text: `Playing ${item.title} on the Apple TV${body.marked_watched ? "" : " (not marked as watched)"}` };
  } catch (e) {
    message.value = { tone: "error", text: e instanceof Error ? e.message : String(e) };
  } finally {
    busy.value = false;
  }
}

const state = (i: Item) => (i.type === "Series" ? (i.unplayed_episodes ? `${i.unplayed_episodes} unplayed` : "all watched") : i.watched ? "watched" : "unwatched");
</script>

<template>
  <PageLayout eyebrow="Modules" title="Media" subtitle="Search the Jellyfin library and play on the Apple TV">
    <Card>
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="search">
        <div class="flex-1 min-w-48"><Input v-model="query" label="Search" placeholder="Series or movie" /></div>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-f-text-muted">Type</span>
          <select v-model="type" class="surface-inset px-3 py-2 text-f-text outline-none focus:border-f-accent">
            <option value="any">Any</option>
            <option value="series">Series</option>
            <option value="movie">Movies</option>
          </select>
        </label>
        <Button type="submit" :disabled="busy || !query.trim()">Search</Button>
      </form>
      <p v-if="message" :class="message.tone === 'error' ? 'text-f-error' : 'text-f-success'">{{ message.text }}</p>
    </Card>
    <DataTable :columns="columns" :rows="results" row-key="id" empty="Search for something to see results">
      <template #cell-title="{ row }">
        <div class="font-medium text-f-text-bright">{{ row.title }}</div>
        <div v-if="row.series" class="text-xs text-f-text-muted">{{ row.series }} S{{ row.season }}E{{ row.episode }}</div>
      </template>
      <template #cell-type="{ value }"><Badge>{{ value }}</Badge></template>
      <template #cell-state="{ row }">{{ state(row as Item) }}</template>
      <template #actions="{ row }">
        <Button v-if="row.type !== 'Series'" variant="ghost" :disabled="busy" @click="play(row as Item)">Play</Button>
      </template>
    </DataTable>
  </PageLayout>
</template>
