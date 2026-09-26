<script setup lang="ts">
withDefaults(defineProps<{ variant?: "primary" | "ghost" | "danger"; disabled?: boolean; type?: "button" | "submit" }>(), {
  variant: "primary",
  disabled: false,
  type: "button",
});
const styles = {
  primary: "bg-f-accent hover:bg-f-accent-strong text-white",
  ghost: "bg-transparent hover:bg-f-surface-hover text-f-text border border-f-border",
  danger: "bg-f-error/90 hover:bg-f-error text-white",
};
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    :class="['inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed', styles[variant]]"
  >
    <slot />
  </button>
</template>
