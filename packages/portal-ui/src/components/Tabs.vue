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
  <!-- Scrolls sideways when the tabs don't fit, instead of widening the page. -->
  <div class="inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-f-border bg-f-surface/60 p-1" role="tablist">
    <button
      v-for="t in items"
      :key="t.id"
      type="button"
      role="tab"
      :aria-selected="model === t.id"
      :class="['shrink-0 whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition', model === t.id ? 'bg-f-accent text-white' : 'text-f-text-muted hover:text-f-text']"
      @click="model = t.id"
    >
      {{ t.label }}<span v-if="t.count !== undefined" class="ml-2 opacity-70">{{ t.count }}</span>
    </button>
  </div>
</template>
