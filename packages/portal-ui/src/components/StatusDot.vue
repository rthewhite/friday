<script setup lang="ts">
withDefaults(defineProps<{ tone?: "neutral" | "success" | "warning" | "error" | "accent"; label?: string }>(), { tone: "neutral" });
const colors = { neutral: "bg-f-text-muted", success: "bg-f-success", warning: "bg-f-warning", error: "bg-f-error", accent: "bg-f-accent-bright" };
</script>

<template>
  <span class="inline-flex items-center gap-2 text-sm">
    <span :class="['inline-block w-2 h-2 rounded-full shrink-0', colors[tone]]" />
    <span v-if="label" class="text-f-text">{{ label }}</span>
  </span>
</template>
