<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { useRoute } from "vue-router";
import type { ModuleUi } from "@friday/portal-ui";
import Sidebar, { type NavItem } from "./Sidebar.vue";
import AdminOnly from "./AdminOnly.vue";
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
const open = ref(false);
watch(() => route.fullPath, () => (open.value = false));

// The sidebar leaves out a section without items, such as Modules when no module UI is usable.
const groups = NAV_GROUPS;
const items = computed<NavItem[]>(() => navItems(uis, isEnabled, me.value?.role));
</script>

<template>
  <div class="min-h-screen md:flex">
    <header class="md:hidden flex items-center justify-between px-4 h-14 border-b border-f-border-subtle bg-f-surface/80 backdrop-blur sticky top-0 z-20">
      <span class="flex items-center gap-2 font-semibold text-f-text-bright"><span class="grid h-7 w-7 place-items-center rounded-lg bg-f-accent text-white text-sm">F</span>Friday</span>
      <button class="rounded-md px-3 py-1 border border-f-border text-f-text" aria-label="Menu" @click="open = !open">☰</button>
    </header>
    <Sidebar :items="items" :groups="groups" :class="[open ? 'block' : 'hidden', 'md:block']" />
    <main class="flex-1 min-w-0">
      <AdminOnly v-if="blocked" />
      <RouterView v-else />
    </main>
  </div>
</template>
