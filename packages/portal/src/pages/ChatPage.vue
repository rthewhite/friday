<script setup lang="ts">
/**
 * Typed chat with Friday: a list of chat threads and the selected thread, whose next answer streams
 * in (thought summaries, text, tool activity). `/chat` is a new thread, `/chat/:id` an existing one.
 * After each turn the thread is reloaded from the store, so what is shown is what was recorded.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Button, Icon, formatDateTime } from "@friday/portal-ui";
import { api } from "../composables/useApi.js";
import { useChatStream } from "../composables/useChatStream.js";
import type { Conversation, Entry, Summary } from "../lib/conversations.js";
import { renderMarkdown } from "../lib/markdown.js";
import TranscriptEntry from "../components/TranscriptEntry.vue";

const route = useRoute();
const router = useRouter();
const routeId = computed(() => (typeof route.params.id === "string" && route.params.id ? route.params.id : undefined));

// ---- thread list ------------------------------------------------------------
const threads = ref<Summary[]>([]);
const next = ref<string | null>(null);
const listLoading = ref(false);
const listError = ref<string | null>(null);
const showThreads = ref(false);

async function loadThreads(more = false) {
  listLoading.value = true;
  try {
    const cursor = more && next.value ? `&before=${encodeURIComponent(next.value)}` : "";
    const page = await api<{ conversations: Summary[]; next: string | null }>(`/api/conversations?channel=chat${cursor}`);
    threads.value = more ? [...threads.value, ...page.conversations] : page.conversations;
    next.value = page.next;
    listError.value = null;
  } catch (e) {
    listError.value = e instanceof Error ? e.message : String(e);
  } finally {
    listLoading.value = false;
  }
}

// ---- selected thread --------------------------------------------------------
const thread = ref<Conversation | null>(null);
/** The thread shown: the route's, or the one a new chat just created while its first turn streams. */
const threadId = ref<string | undefined>(routeId.value);
const notFound = ref(false);
const threadError = ref<string | null>(null);
/** The error of the last turn, shown below what was stored of it. */
const turnError = ref<string | null>(null);

async function loadThread(id: string) {
  try {
    const c = await api<Conversation>(`/api/conversations/${encodeURIComponent(id)}`);
    if (threadId.value !== id) return; // navigated away meanwhile
    if (c.channel !== "chat") throw new Error("not found");
    thread.value = c;
    notFound.value = false;
    threadError.value = null;
  } catch (e) {
    if (threadId.value !== id) return;
    thread.value = null;
    const message = e instanceof Error ? e.message : String(e);
    notFound.value = /not found|unknown conversation/i.test(message);
    threadError.value = notFound.value ? null : message;
  }
}

function select(id: string | undefined) {
  threadId.value = id;
  thread.value = null;
  notFound.value = false;
  threadError.value = null;
  turnError.value = null;
  showThreads.value = false;
  if (id) void loadThread(id);
}

watch(routeId, (id) => {
  // A new thread's URL changes while its first turn streams; that is the thread already shown.
  if (id === threadId.value) return;
  select(id);
});

// ---- sending ------------------------------------------------------------------
const { turn, send } = useChatStream();
const draft = ref("");
const running = computed(() => turn.value?.running === true);
/** The thread the streaming turn belongs to (undefined until a new thread is named). */
const turnFor = ref<string | undefined>();
/** The streaming turn, when it belongs to the thread shown. */
const liveTurn = computed(() => (turn.value && turnFor.value === threadId.value ? turn.value : null));

async function submit() {
  const text = draft.value.trim();
  if (!text || running.value) return;
  draft.value = "";
  turnError.value = null;
  turnFor.value = threadId.value;
  const startedIn = threadId.value;
  const result = await send(text, threadId.value, (id) => {
    const stillHere = threadId.value === startedIn;
    turnFor.value = id;
    // A new thread gets its URL, unless the user moved to another thread meanwhile.
    if (stillHere && threadId.value !== id) {
      threadId.value = id;
      void router.replace(`/chat/${encodeURIComponent(id)}`);
    }
  });
  const id = result.conversationId;
  if (!id) {
    // Refused before anything was stored (busy thread, unreachable server): keep the text to retry.
    if (threadId.value === startedIn) {
      turnError.value = turn.value?.error ?? null;
      if (!draft.value) draft.value = text;
    }
  } else if (id === threadId.value) {
    turnError.value = turn.value?.error ?? null;
    await loadThread(id);
  }
  turn.value = null;
  turnFor.value = undefined;
  void loadThreads();
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  void submit();
}

// ---- rendering helpers -------------------------------------------------------
/** The streaming turn's message, shown until the reloaded thread contains it. */
const liveUser = computed<Entry | null>(() => (liveTurn.value ? { seq: -1, at: new Date().toISOString(), kind: "user", input: "text", text: liveTurn.value.text } : null));
const toolEntry = (i: { name: string; args: unknown; result?: unknown; settled: boolean; at: string }): Entry =>
  ({ seq: -1, at: i.at, kind: "tool", name: i.name, args: i.args, truncated: false, ...(i.settled ? { result: i.result } : {}) }) as Entry;
const title = computed(() => thread.value?.preview ?? (threadId.value ? "Chat" : "New chat"));

const scroller = ref<HTMLElement | null>(null);
const scrollDown = async () => {
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
};
watch(() => [thread.value?.entries.length, turn.value?.items.length, turn.value?.items[turn.value.items.length - 1]], scrollDown, { deep: true });

onMounted(() => {
  void loadThreads();
  if (threadId.value) void loadThread(threadId.value);
});
</script>

<template>
  <div class="flex h-[calc(100dvh-3.5rem)] md:h-dvh">
    <!-- Thread list: a column from md up, a toggled panel below. -->
    <aside :class="[showThreads ? 'flex' : 'hidden', 'md:flex absolute md:static inset-x-0 top-14 md:top-auto bottom-0 z-10 w-full md:w-72 shrink-0 flex-col border-r border-f-border-subtle bg-f-surface md:bg-f-surface/40']">
      <div class="flex items-center justify-between gap-2 p-3">
        <span class="text-xs font-semibold uppercase tracking-widest text-f-text-muted">Threads</span>
        <Button variant="ghost" @click="router.push('/chat')"><Icon name="plus" />New chat</Button>
      </div>
      <p v-if="listError" class="px-3 text-sm text-f-error">{{ listError }}</p>
      <ul class="flex-1 overflow-y-auto px-2 pb-3">
        <li v-for="t in threads" :key="t.id">
          <RouterLink
            :to="`/chat/${encodeURIComponent(t.id)}`"
            :class="['block rounded-lg px-3 py-2 transition hover:bg-f-surface-hover', t.id === threadId && 'bg-f-accent-muted']"
            @click="showThreads = false"
          >
            <span class="line-clamp-1 break-all text-sm text-f-text-bright">{{ t.preview ?? "…" }}</span>
            <span class="text-xs text-f-text-muted">{{ formatDateTime(t.lastActivityAt) }}</span>
          </RouterLink>
        </li>
        <li v-if="!threads.length && !listLoading" class="px-3 py-2 text-sm text-f-text-muted">No chats yet.</li>
      </ul>
      <div v-if="next" class="flex justify-center p-2">
        <Button variant="ghost" :disabled="listLoading" @click="loadThreads(true)">{{ listLoading ? "Loading…" : "Load more" }}</Button>
      </div>
    </aside>

    <!-- The selected thread. -->
    <section class="flex min-w-0 flex-1 flex-col">
      <header class="flex items-center gap-3 border-b border-f-border-subtle px-4 py-3 md:px-8">
        <button class="md:hidden rounded-md border border-f-border px-2 py-1 text-f-text" aria-label="Threads" @click="showThreads = !showThreads"><Icon name="message" /></button>
        <div class="min-w-0">
          <span class="text-xs font-semibold uppercase tracking-widest text-f-accent-bright">Assistant</span>
          <h1 class="line-clamp-1 break-all text-xl font-semibold text-f-text-bright">{{ title }}</h1>
        </div>
      </header>

      <div ref="scroller" class="flex-1 overflow-y-auto px-4 py-4 md:px-8">
        <div class="mx-auto flex max-w-3xl flex-col gap-3">
          <div v-if="notFound" class="surface-card p-4 text-sm text-f-text">
            This chat does not exist (or is not a chat).
            <RouterLink to="/chat" class="text-f-accent-bright underline">Start a new chat</RouterLink>
          </div>
          <p v-else-if="threadError" class="text-sm text-f-error">{{ threadError }}</p>
          <p v-else-if="!thread && !liveTurn && !threadId" class="text-sm text-f-text-muted">Ask Friday anything. Answers can use your tools, and you can come back to this thread later.</p>

          <ol class="flex flex-col gap-3">
            <TranscriptEntry v-for="e in thread?.entries ?? []" :key="e.seq" :entry="e" markdown />
            <template v-if="liveTurn">
              <TranscriptEntry v-if="liveUser" :entry="liveUser" />
              <template v-for="i in liveTurn.items" :key="i.id">
                <li v-if="i.kind === 'thinking'" class="flex flex-col items-start">
                  <details class="max-w-[85%] text-xs text-f-text-muted" open>
                    <summary class="cursor-pointer select-none">Thinking</summary>
                    <!-- eslint-disable-next-line vue/no-v-html -- raw HTML disabled, see lib/markdown -->
                    <div class="f-markdown mt-1 opacity-80" v-html="renderMarkdown(i.text)" />
                  </details>
                </li>
                <TranscriptEntry v-else-if="i.kind === 'text'" :entry="{ seq: -1, at: new Date().toISOString(), kind: 'assistant', text: i.text, interrupted: false }" markdown />
                <TranscriptEntry v-else :entry="toolEntry(i)" :pending="!i.settled" />
              </template>
              <li v-if="liveTurn.running && !liveTurn.items.length" class="text-sm text-f-text-muted">Friday is thinking…</li>
            </template>
          </ol>
          <p v-if="turnError" class="surface-inset px-3 py-2 text-sm text-f-error">The answer failed: {{ turnError }}</p>
        </div>
      </div>

      <form v-if="!notFound" class="border-t border-f-border-subtle px-4 py-3 md:px-8" @submit.prevent="submit">
        <div class="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            v-model="draft"
            rows="2"
            :disabled="running"
            placeholder="Message Friday… (Enter sends, Shift+Enter for a new line)"
            class="min-h-12 max-h-48 flex-1 resize-y rounded-xl border border-f-border bg-f-surface px-3 py-2 text-sm text-f-text-bright placeholder:text-f-text-muted focus:border-f-accent focus:outline-none disabled:opacity-60"
            @keydown="onKey"
          />
          <Button type="submit" :disabled="running || !draft.trim()"><Icon name="send" />Send</Button>
        </div>
      </form>
    </section>
  </div>
</template>
