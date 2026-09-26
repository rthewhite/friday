<script setup lang="ts">
defineProps<{ title: string; subtitle?: string; eyebrow?: string }>();
</script>

<template>
  <section class="flex flex-col gap-6 p-4 md:p-8 max-w-6xl w-full mx-auto">
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div class="flex flex-col gap-1">
        <span v-if="eyebrow" class="text-xs font-semibold uppercase tracking-widest text-f-accent-bright">{{ eyebrow }}</span>
        <h1 class="text-3xl font-semibold text-f-text-bright">{{ title }}</h1>
        <p v-if="subtitle" class="text-f-text-muted">{{ subtitle }}</p>
      </div>
      <div class="flex items-center gap-2 pt-1"><slot name="actions" /></div>
    </header>
    <slot />
  </section>
</template>
