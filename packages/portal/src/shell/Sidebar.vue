<script setup lang="ts">
import { Icon } from "@friday/portal-ui";

export interface NavItem {
  to: string;
  label: string;
  icon?: string;
  group: string;
}
defineProps<{ items: NavItem[]; groups: string[] }>();
</script>

<template>
  <nav class="md:w-60 md:shrink-0 md:h-screen md:sticky md:top-0 border-b md:border-b-0 md:border-r border-f-border-subtle bg-f-surface/60 backdrop-blur px-3 py-4 flex flex-col gap-1">
    <RouterLink to="/" class="hidden md:flex items-center gap-3 px-3 pb-6">
      <span class="grid h-8 w-8 place-items-center rounded-lg bg-f-accent text-white font-semibold">F</span>
      <span class="text-lg font-semibold text-f-text-bright">Friday</span>
    </RouterLink>
    <template v-for="g in groups" :key="g">
      <div v-if="items.some((i) => i.group === g)" class="px-3 pt-4 pb-2 text-xs font-semibold uppercase tracking-widest text-f-text-muted first:pt-0">{{ g }}</div>
      <RouterLink
        v-for="item in items.filter((i) => i.group === g)"
        :key="item.to"
        :to="item.to"
        class="flex items-center gap-3 rounded-lg px-3 py-2 text-f-text hover:bg-f-surface-hover transition"
        active-class="bg-f-accent text-white hover:bg-f-accent-strong"
        :exact-active-class="item.to === '/' ? 'bg-f-accent text-white hover:bg-f-accent-strong' : ''"
      >
        <Icon :name="item.icon" :size="18" />
        <span>{{ item.label }}</span>
      </RouterLink>
    </template>
  </nav>
</template>
