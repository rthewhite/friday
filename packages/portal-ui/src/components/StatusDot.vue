<script setup lang="ts">
/** `label` renders next to the dot; `title` gives a tooltip and accessible name for dot-only use. */
withDefaults(defineProps<{ tone?: "neutral" | "success" | "warning" | "error" | "accent"; label?: string; title?: string }>(), { tone: "neutral" });
const colors = { neutral: "bg-f-text-muted", success: "bg-f-success", warning: "bg-f-warning", error: "bg-f-error", accent: "bg-f-accent-bright" };
</script>

<template>
  <span class="inline-flex items-center justify-center gap-2 text-sm" :title="title" :aria-label="title">
    <span :class="['inline-block w-2.5 h-2.5 rounded-full shrink-0', colors[tone]]" />
    <span v-if="label" class="text-f-text">{{ label }}</span>
  </span>
</template>
