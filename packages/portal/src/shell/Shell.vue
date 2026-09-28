<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { useRoute } from "vue-router";
import type { ModuleUi } from "@friday/portal-ui";
import Sidebar, { type NavItem } from "./Sidebar.vue";
import { useModules } from "../composables/useModules.js";

const uis = inject<ModuleUi[]>("moduleUis", []);
const { isEnabled } = useModules();
const route = useRoute();
const open = ref(false);
watch(() => route.fullPath, () => (open.value = false));

const groups = ["Assistant", "Modules", "System"];
const items = computed<NavItem[]>(() => [
  { to: "/", label: "Talk", icon: "mic", group: "Assistant" },
  { to: "/modules", label: "Modules", icon: "grid", group: "Modules" },
  ...uis
    .filter((u) => isEnabled(u.id))
    .sort((a, b) => (a.nav.order ?? 100) - (b.nav.order ?? 100) || a.nav.label.localeCompare(b.nav.label))
    .map((u) => ({ to: `/m/${u.id}`, label: u.nav.label, icon: u.nav.icon, group: "Modules" })),
  { to: "/settings/config", label: "Configuration", icon: "settings", group: "System" },
  { to: "/settings/keys", label: "Remote modules", icon: "key", group: "System" },
  { to: "/settings/jobs", label: "Jobs", icon: "clock", group: "System" },
]);
</script>

<template>
  <div class="min-h-screen md:flex">
    <header class="md:hidden flex items-center justify-between px-4 h-14 border-b border-f-border-subtle bg-f-surface/80 backdrop-blur sticky top-0 z-20">
      <span class="flex items-center gap-2 font-semibold text-f-text-bright"><span class="grid h-7 w-7 place-items-center rounded-lg bg-f-accent text-white text-sm">F</span>Friday</span>
      <button class="rounded-md px-3 py-1 border border-f-border text-f-text" aria-label="Menu" @click="open = !open">☰</button>
    </header>
    <Sidebar :items="items" :groups="groups" :class="[open ? 'block' : 'hidden', 'md:block']" />
    <main class="flex-1 min-w-0">
      <RouterView />
    </main>
  </div>
</template>
