<script setup lang="ts">
export interface TabItem {
  id: string;
  label: string;
  count?: number;
}
defineProps<{ items: TabItem[] }>();
const model = defineModel<string>({ required: true });
</script>

<template>
  <div class="inline-flex items-center gap-1 rounded-full border border-f-border bg-f-surface/60 p-1" role="tablist">
    <button
      v-for="t in items"
      :key="t.id"
      type="button"
      role="tab"
      :aria-selected="model === t.id"
      :class="['rounded-full px-4 py-1.5 text-sm font-medium transition', model === t.id ? 'bg-f-accent text-white' : 'text-f-text-muted hover:text-f-text']"
      @click="model = t.id"
    >
      {{ t.label }}<span v-if="t.count !== undefined" class="ml-2 opacity-70">{{ t.count }}</span>
    </button>
  </div>
</template>
