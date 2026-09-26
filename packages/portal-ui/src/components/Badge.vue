<script setup lang="ts">
withDefaults(defineProps<{ tone?: "neutral" | "success" | "warning" | "error" | "accent" }>(), { tone: "neutral" });
const tones = {
  neutral: "bg-f-surface-elevated text-f-text-muted border-f-border",
  success: "bg-f-success/15 text-f-success border-f-success/30",
  warning: "bg-f-warning/15 text-f-warning border-f-warning/30",
  error: "bg-f-error/15 text-f-error border-f-error/30",
  accent: "bg-f-accent-muted text-f-accent-bright border-f-accent/30",
};
</script>

<template>
  <span :class="['inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', tones[tone]]"><slot /></span>
</template>
