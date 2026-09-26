<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>();
</script>

<template>
  <section class="flex flex-col gap-5 p-4 md:p-8 max-w-5xl w-full mx-auto">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold text-f-text-bright">{{ title }}</h1>
        <p v-if="subtitle" class="text-f-text-muted mt-1">{{ subtitle }}</p>
      </div>
      <div class="flex items-center gap-2"><slot name="actions" /></div>
    </header>
    <slot />
  </section>
</template>
