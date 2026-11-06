<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import Icon from "./Icon.vue";

defineProps<{ title: string; subtitle?: string }>();
const open = defineModel<boolean>("open", { required: true });
const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") open.value = false; };
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-40 flex justify-end">
      <div class="absolute inset-0 bg-black/50" @click="open = false" />
      <!-- The safe-area insets are 0 except under a notch or above a home indicator. -->
      <aside class="relative h-dvh w-full sm:w-[28rem] bg-f-surface border-l border-f-border shadow-2xl flex flex-col pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]" role="dialog" aria-modal="true">
        <header class="flex items-start justify-between gap-3 px-5 pb-4 pt-[max(1rem,env(safe-area-inset-top))] border-b border-f-border-subtle">
          <div>
            <h2 class="text-base font-semibold text-f-text-bright">{{ title }}</h2>
            <p v-if="subtitle" class="text-sm text-f-text-muted mt-0.5">{{ subtitle }}</p>
          </div>
          <button type="button" class="rounded-md p-1 text-f-text-muted hover:text-f-text hover:bg-f-surface-hover" aria-label="Close" @click="open = false"><Icon name="close" :size="18" /></button>
        </header>
        <div :class="['flex-1 overflow-y-auto px-5 pt-4 flex flex-col gap-4', $slots.footer ? 'pb-4' : 'pb-[max(1rem,env(safe-area-inset-bottom))]']"><slot /></div>
        <footer v-if="$slots.footer" class="flex flex-wrap items-center justify-end gap-2 px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-f-border-subtle"><slot name="footer" /></footer>
      </aside>
    </div>
  </Teleport>
</template>
