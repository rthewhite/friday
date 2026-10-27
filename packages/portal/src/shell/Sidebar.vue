<script setup lang="ts">
import { ref } from "vue";
import { Icon } from "@friday/portal-ui";
import { useSession } from "../composables/useSession.js";

export interface NavItem {
  to: string;
  label: string;
  icon?: string;
  group: string;
}
defineProps<{ items: NavItem[]; groups: string[] }>();

const { me, logout } = useSession();
const leaving = ref(false);
const error = ref<string | null>(null);
async function logOut() {
  leaving.value = true;
  error.value = null;
  try {
    await logout();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    leaving.value = false;
  }
}
</script>

<template>
  <nav class="md:w-60 md:shrink-0 md:h-screen md:sticky md:top-0 border-b md:border-b-0 md:border-r border-f-border-subtle bg-f-surface/60 backdrop-blur px-3 py-4 flex flex-col gap-1">
    <RouterLink to="/" class="hidden md:flex items-center gap-3 px-3 pb-6">
      <span class="grid h-8 w-8 place-items-center rounded-lg bg-f-accent text-white font-semibold">F</span>
      <span class="text-lg font-semibold text-f-text-bright">Friday</span>
    </RouterLink>
    <template v-for="g in groups" :key="g">
      <div v-if="items.some((i) => i.group === g)" class="px-3 pt-4 pb-2 text-xs font-semibold uppercase tracking-widest text-f-text-muted first:pt-0">{{ g }}</div>
      <RouterLink
        v-for="item in items.filter((i) => i.group === g)"
        :key="item.to"
        :to="item.to"
        class="flex items-center gap-3 rounded-lg px-3 py-2 text-f-text hover:bg-f-surface-hover transition"
        active-class="bg-f-accent text-white hover:bg-f-accent-strong"
        :exact-active-class="item.to === '/' ? 'bg-f-accent text-white hover:bg-f-accent-strong' : ''"
      >
        <Icon :name="item.icon" :size="18" />
        <span>{{ item.label }}</span>
      </RouterLink>
    </template>
    <div v-if="me" class="mt-auto border-t border-f-border-subtle pt-3 px-3 flex items-center gap-3">
      <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-f-surface-hover text-f-text-bright text-sm font-semibold">{{ me.name.slice(0, 1).toUpperCase() }}</span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm text-f-text-bright">{{ me.name }}</span>
        <span class="block text-xs text-f-text-muted">{{ me.role === "admin" ? "Admin" : "Member" }}{{ me.authEnabled ? "" : " · no login (dev)" }}</span>
      </span>
      <button
        v-if="me.authEnabled"
        type="button"
        class="rounded-md px-2 py-1 text-sm text-f-text-muted hover:text-f-text-bright hover:bg-f-surface-hover disabled:opacity-50"
        :disabled="leaving"
        @click="logOut"
      >Log out</button>
    </div>
    <p v-if="error" class="px-3 text-xs text-f-error">{{ error }}</p>
  </nav>
</template>
