<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { PageLayout, Button } from "@friday/portal-ui";
import { useVoiceSession } from "../composables/useVoiceSession.js";

const { state, live, log, toggle } = useVoiceSession();
const logEl = ref<HTMLElement | null>(null);
watch(() => log.value.length, async () => { await nextTick(); logEl.value?.scrollTo({ top: logEl.value.scrollHeight }); });
</script>

<template>
  <PageLayout eyebrow="Assistant" title="Talk" subtitle="Push to talk with Friday. Browsers only allow the microphone on localhost or HTTPS.">
    <div class="flex items-center gap-4">
      <Button :variant="live ? 'danger' : 'primary'" @click="toggle">{{ live ? "Stop" : "Start talking" }}</Button>
      <span class="text-sm" :class="state.startsWith('error') ? 'text-f-error' : 'text-f-text-muted'">{{ state }}</span>
    </div>
    <div ref="logEl" class="surface-card p-4 flex flex-col gap-2 min-h-64 max-h-[60vh] overflow-y-auto">
      <p v-if="!log.length" class="text-f-text-muted text-sm">Transcript appears here.</p>
      <div
        v-for="e in log"
        :key="e.id"
        :class="[
          'rounded-xl px-3 py-2 max-w-[85%] whitespace-pre-wrap',
          e.kind === 'user' && 'self-end bg-f-accent-muted text-f-text-bright',
          e.kind === 'bot' && 'self-start bg-f-surface-elevated',
          e.kind === 'tool' && 'self-center text-xs font-mono text-f-text-muted',
        ]"
      >{{ e.text }}</div>
    </div>
  </PageLayout>
</template>
