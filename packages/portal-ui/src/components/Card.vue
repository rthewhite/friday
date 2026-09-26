<script setup lang="ts">
defineProps<{ title?: string }>();
</script>

<template>
  <div class="surface-card p-4 md:p-5 flex flex-col gap-3">
    <div v-if="title || $slots.header" class="flex items-center justify-between gap-2">
      <h2 v-if="title" class="font-medium text-f-text-bright">{{ title }}</h2>
      <slot name="header" />
    </div>
    <slot />
  </div>
</template>
