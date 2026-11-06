<script setup lang="ts">
/** The Chat page's list of threads: the column beside the thread from md up, and the panel over it on phones. */
import { Button, Icon, formatDateTime } from "@friday/portal-ui";
import type { Summary } from "../lib/conversations.js";

defineProps<{ threads: Summary[]; current?: string; hasMore: boolean; loading: boolean; error: string | null }>();
const emit = defineEmits<{ new: []; pick: [id: string]; more: [] }>();
</script>

<template>
  <div class="flex items-center justify-between gap-2 p-3">
    <span class="text-xs font-semibold uppercase tracking-widest text-f-text-muted">Threads</span>
    <Button variant="ghost" @click="emit('new')"><Icon name="plus" />New chat</Button>
  </div>
  <p v-if="error" class="px-3 text-sm text-f-error">{{ error }}</p>
  <ul class="flex-1 overflow-y-auto px-2 pb-3">
    <li v-for="t in threads" :key="t.id">
      <RouterLink
        :to="`/chat/${encodeURIComponent(t.id)}`"
        :class="['block rounded-lg px-3 py-2 transition hover:bg-f-surface-hover', t.id === current && 'bg-f-accent-muted']"
        @click="emit('pick', t.id)"
      >
        <span class="line-clamp-1 break-all text-sm text-f-text-bright">{{ t.preview ?? "…" }}</span>
        <span class="text-xs text-f-text-muted">{{ formatDateTime(t.lastActivityAt) }}</span>
      </RouterLink>
    </li>
    <li v-if="!threads.length && !loading" class="px-3 py-2 text-sm text-f-text-muted">No chats yet.</li>
  </ul>
  <div v-if="hasMore" class="flex justify-center p-2">
    <Button variant="ghost" :disabled="loading" @click="emit('more')">{{ loading ? "Loading…" : "Load more" }}</Button>
  </div>
</template>
