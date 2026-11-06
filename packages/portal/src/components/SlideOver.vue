<script setup lang="ts">
/**
 * A panel that slides in from the left over the page, below `md` only: the phone menu and the Chat page's thread
 * list. It closes on the backdrop and Escape, moves the focus into itself when opened and back when closed, and
 * keeps the page behind it from scrolling while open.
 */
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { DESKTOP, useMediaQuery } from "../composables/useMediaQuery.js";

const props = defineProps<{
  /** The panel's accessible name. */
  label: string;
  id?: string;
  /** Where the focus goes back to on close; by default whatever had it when the panel opened. */
  returnFocus?: HTMLElement | null;
}>();
const open = defineModel<boolean>("open", { required: true });

const panel = ref<HTMLElement | null>(null);
let focusedBefore: HTMLElement | null = null;
/** The page's own `overflow` on <html>, put back on close; undefined while the lock isn't held. */
let overflowBefore: string | undefined;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") open.value = false;
}

/** The page behind the panel (the panel is teleported out of it): inert while open, so Tab and screen readers stay in the panel. */
const page = () => document.getElementById("app");
let madeInert = false;

function lock() {
  const root = document.documentElement;
  if (overflowBefore === undefined) overflowBefore = root.style.overflow;
  root.style.overflow = "hidden";
  const app = page();
  if (app && !app.hasAttribute("inert")) {
    app.setAttribute("inert", "");
    madeInert = true;
  }
  window.addEventListener("keydown", onKey);
}

function unlock() {
  window.removeEventListener("keydown", onKey);
  if (madeInert) {
    page()?.removeAttribute("inert");
    madeInert = false;
  }
  if (overflowBefore === undefined) return;
  document.documentElement.style.overflow = overflowBefore;
  overflowBefore = undefined;
}

watch(
  open,
  async (now, before) => {
    if (now) {
      focusedBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      lock();
      await nextTick();
      (panel.value?.querySelector<HTMLElement>(FOCUSABLE) ?? panel.value)?.focus();
    } else if (before) {
      unlock();
      (props.returnFocus ?? focusedBefore)?.focus();
      focusedBefore = null;
    }
  },
  { immediate: true },
);

// Widened to the desktop layout while open: the panel is hidden there, so close it rather than keep the page locked.
const desktop = useMediaQuery(DESKTOP);
watch(desktop, (wide) => {
  if (wide) open.value = false;
});

onBeforeUnmount(unlock);
</script>

<template>
  <Teleport to="body">
    <div class="md:hidden">
      <Transition
        enter-active-class="transition-opacity duration-200 motion-reduce:transition-none"
        leave-active-class="transition-opacity duration-150 motion-reduce:transition-none"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div v-if="open" class="fixed inset-0 z-40 touch-none bg-black/50" data-slide-over-backdrop @click="open = false" />
      </Transition>
      <Transition
        enter-active-class="transition-transform duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="transition-transform duration-150 ease-in motion-reduce:transition-none"
        enter-from-class="-translate-x-full"
        leave-to-class="-translate-x-full"
      >
        <!-- The insets are 0 except under a notch, beside rounded corners or above a home indicator. -->
        <aside
          v-if="open"
          :id="id"
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-label="label"
          tabindex="-1"
          class="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto overscroll-contain border-r border-f-border bg-f-surface shadow-2xl outline-none pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] f-no-scrollbar"
        >
          <slot />
          <!-- An element, not padding: WebKit leaves a scrolling panel's own bottom padding out of what scrolls into view. -->
          <div class="h-[env(safe-area-inset-bottom)] shrink-0" aria-hidden="true" />
        </aside>
      </Transition>
    </div>
  </Teleport>
</template>
