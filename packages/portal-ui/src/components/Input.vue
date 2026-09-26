<script setup lang="ts">
withDefaults(defineProps<{ placeholder?: string; type?: string; label?: string }>(), { type: "text" });
const model = defineModel<string>({ default: "" });
</script>

<template>
  <label class="flex flex-col gap-1 text-sm">
    <span v-if="label" class="text-f-text-muted">{{ label }}</span>
    <input
      v-model="model"
      :type="type"
      :placeholder="placeholder"
      class="surface-inset px-3 py-2 text-f-text placeholder:text-f-text-muted outline-none focus:border-f-accent"
    />
  </label>
</template>
