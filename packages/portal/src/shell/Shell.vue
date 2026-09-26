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

const items = computed<NavItem[]>(() => [
  { to: "/", label: "Talk", icon: "🎙" },
  { to: "/modules", label: "Modules", icon: "▦" },
  ...uis
    .filter((u) => isEnabled(u.id))
    .sort((a, b) => (a.nav.order ?? 100) - (b.nav.order ?? 100) || a.nav.label.localeCompare(b.nav.label))
    .map((u) => ({ to: `/m/${u.id}`, label: u.nav.label, icon: u.nav.icon })),
  { to: "/settings/config", label: "Configuration", icon: "⚙", group: "Settings" },
  { to: "/settings/keys", label: "Remote modules", icon: "🔑", group: "Settings" },
]);
</script>

<template>
  <div class="min-h-screen md:flex">
    <header class="md:hidden flex items-center justify-between px-4 h-14 border-b border-f-border-subtle bg-f-surface/80 backdrop-blur sticky top-0 z-20">
      <span class="font-semibold text-f-text-bright">Friday</span>
      <button class="rounded-md px-3 py-1 border border-f-border text-f-text" aria-label="Menu" @click="open = !open">☰</button>
    </header>
    <Sidebar :items="items" :class="[open ? 'block' : 'hidden', 'md:block']" />
    <main class="flex-1 min-w-0">
      <RouterView />
    </main>
  </div>
</template>
