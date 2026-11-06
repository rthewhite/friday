<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { Icon, type ModuleUi } from "@friday/portal-ui";
import Sidebar from "./Sidebar.vue";
import AdminOnly from "./AdminOnly.vue";
import SlideOver from "../components/SlideOver.vue";
import { useModules } from "../composables/useModules.js";
import { useSession } from "../composables/useSession.js";
import { isAdminPath } from "../lib/auth.js";
import { NAV_GROUPS, navItems } from "../lib/nav.js";

const uis = inject<ModuleUi[]>("moduleUis", []);
const { isEnabled } = useModules();
const route = useRoute();
const { me } = useSession();
// Members get no System section, and a settings URL opened directly shows a notice instead of the page (whose API
// calls would only be refused).
const blocked = computed(() => isAdminPath(route.path) && me.value?.role !== "admin");
/** The phone menu (below md). */
const open = ref(false);
const menuButton = ref<HTMLElement | null>(null);
watch(() => route.fullPath, () => (open.value = false));

// The sidebar leaves out a section without items, such as Modules when no module UI is usable.
const items = computed(() => navItems(uis, isEnabled, me.value?.role));
</script>

<template>
  <div class="min-h-dvh md:flex">
    <!-- Phones: a top bar that stays at the top, below the status bar, and opens the navigation over the page. -->
    <header class="md:hidden sticky top-0 z-20 h-[var(--f-topbar-h)] pt-[env(safe-area-inset-top)] border-b border-f-border-subtle bg-f-surface/80 backdrop-blur">
      <div class="flex h-14 items-center justify-between pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        <RouterLink to="/" class="flex items-center gap-2 font-semibold text-f-text-bright"><span class="grid h-7 w-7 place-items-center rounded-lg bg-f-accent text-white text-sm">F</span>Friday</RouterLink>
        <button
          ref="menuButton"
          type="button"
          class="grid h-10 w-10 place-items-center rounded-md border border-f-border text-f-text"
          aria-label="Menu"
          aria-controls="phone-menu"
          :aria-expanded="open"
          @click="open = !open"
        ><Icon name="menu" :size="20" /></button>
      </div>
    </header>
    <SlideOver id="phone-menu" v-model:open="open" label="Menu" :return-focus="menuButton">
      <Sidebar :items="items" :groups="NAV_GROUPS" panel @close="open = false" />
    </SlideOver>
    <Sidebar :items="items" :groups="NAV_GROUPS" class="hidden md:block" />
    <main class="flex-1 min-w-0">
      <AdminOnly v-if="blocked" />
      <RouterView v-else />
    </main>
  </div>
</template>
