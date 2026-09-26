<script setup lang="ts">
export interface NavItem {
  to: string;
  label: string;
  icon?: string;
  /** Optional group heading rendered above this item when it differs from the previous item's group. */
  group?: string;
}
defineProps<{ items: NavItem[] }>();
</script>

<template>
  <nav class="md:w-56 md:shrink-0 md:h-screen md:sticky md:top-0 border-b md:border-b-0 md:border-r border-f-border-subtle bg-f-surface/60 backdrop-blur p-3 flex flex-col gap-1">
    <div class="hidden md:flex items-center gap-2 px-3 py-3 mb-2">
      <span class="text-lg font-semibold text-f-text-bright">Friday</span>
    </div>
    <template v-for="(item, i) in items" :key="item.to">
    <div v-if="item.group && item.group !== items[i - 1]?.group" class="px-3 pt-4 pb-1 text-xs uppercase tracking-wide text-f-text-muted">{{ item.group }}</div>
    <RouterLink
      :to="item.to"
      class="flex items-center gap-3 rounded-lg px-3 py-2 text-f-text hover:bg-f-surface-hover transition"
      active-class="bg-f-accent-muted text-f-accent-bright"
      :exact-active-class="item.to === '/' ? 'bg-f-accent-muted text-f-accent-bright' : ''"
    >
      <span class="w-5 text-center" aria-hidden="true">{{ item.icon ?? "•" }}</span>
      <span>{{ item.label }}</span>
    </RouterLink>
    </template>
  </nav>
</template>
