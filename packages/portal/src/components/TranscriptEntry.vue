<script setup lang="ts">
/**
 * One transcript entry: a user or assistant bubble, or a collapsible tool row. Used for stored
 * entries (Conversations drawer, Chat page) and for the chat turn that is still streaming.
 */
import { computed } from "vue";
import { Badge, Icon, formatTime } from "@friday/portal-ui";
import type { Entry } from "../lib/conversations.js";
import { renderMarkdown } from "../lib/markdown.js";

const props = defineProps<{
  entry: Entry;
  /** Render assistant text as markdown (chat) instead of plain text (voice transcripts). */
  markdown?: boolean;
  /** A tool call of the streaming turn that has not settled yet. */
  pending?: boolean;
}>();

const json = (v: unknown, truncated: boolean) => (truncated && typeof v === "string" ? `${v}… (truncated)` : JSON.stringify(v, null, 2));
const html = computed(() => (props.markdown && props.entry.kind === "assistant" ? renderMarkdown(props.entry.text) : ""));
</script>

<template>
  <li :class="['flex flex-col', entry.kind === 'user' ? 'items-end' : 'items-start']">
    <template v-if="entry.kind === 'tool'">
      <details class="w-full surface-inset text-sm">
        <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-f-text">
          <Icon name="settings" :size="14" :class="pending && 'animate-spin'" />
          <span class="font-mono">{{ entry.name }}</span>
          <Badge v-if="entry.truncated" tone="warning">truncated</Badge>
          <Badge v-if="pending">running…</Badge>
          <Badge v-else-if="!('result' in entry)" tone="warning">no result</Badge>
          <span class="ml-auto text-xs text-f-text-muted">{{ formatTime(entry.at) }}</span>
        </summary>
        <div class="flex flex-col gap-2 px-3 pb-3">
          <div class="text-xs uppercase tracking-wide text-f-text-muted">Arguments</div>
          <pre class="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-f-text">{{ json(entry.args, entry.truncated) }}</pre>
          <template v-if="'result' in entry">
            <div class="text-xs uppercase tracking-wide text-f-text-muted">Result</div>
            <pre class="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-f-text">{{ json(entry.result, entry.truncated) }}</pre>
          </template>
          <p v-else-if="!pending" class="text-xs text-f-text-muted">The session closed before the tool finished.</p>
        </div>
      </details>
    </template>
    <template v-else>
      <!-- eslint-disable-next-line vue/no-v-html -- rendered with raw HTML disabled, see lib/markdown -->
      <div v-if="html" class="f-markdown max-w-[85%] rounded-2xl rounded-bl-sm bg-f-surface-elevated px-3 py-2 text-sm text-f-text-bright" v-html="html" />
      <div v-else :class="['max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm', entry.kind === 'user' ? 'bg-f-accent text-white rounded-br-sm' : 'bg-f-surface-elevated text-f-text-bright rounded-bl-sm']">{{ entry.text }}</div>
      <div class="mt-1 flex items-center gap-1.5 text-xs text-f-text-muted">
        <template v-if="entry.kind === 'user'">
          <span :title="entry.input === 'text' ? 'typed' : 'spoken'" class="inline-flex items-center gap-1"><Icon :name="entry.input === 'text' ? 'keyboard' : 'mic'" :size="12" />{{ entry.input === "text" ? "typed" : "spoken" }}</span>
        </template>
        <Badge v-else-if="entry.interrupted" tone="warning">interrupted</Badge>
        <span>{{ formatTime(entry.at) }}</span>
      </div>
    </template>
  </li>
</template>
