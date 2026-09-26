<script setup lang="ts">
import { onMounted } from "vue";
import { PageLayout, Card, Badge, Button } from "@friday/portal-ui";
import { ref } from "vue";
import { useModules, type ApiModule } from "../composables/useModules.js";
import { api } from "../composables/useApi.js";

const { modules, loading, error, refreshModules } = useModules();
onMounted(() => void refreshModules());
const reloading = ref<string | null>(null);
const reloadable = (m: ApiModule) => !m.id.startsWith("mcp:") && m.status !== "connected" && m.status !== "disabled";

async function reload(m: ApiModule) {
  reloading.value = m.id;
  try {
    await api(`/api/modules/${m.id}/reload`, { method: "POST" });
    await refreshModules();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    reloading.value = null;
  }
}

const tone = (s: ApiModule["status"]) => (s === "loaded" || s === "connected" ? "success" : s === "failed" ? "error" : "neutral");
const kind = (m: ApiModule) => (m.id.startsWith("mcp:") ? "MCP server" : m.status === "connected" ? "remote" : "in-process");
</script>

<template>
  <PageLayout title="Modules" subtitle="What this Friday can do right now">
    <template #actions>
      <Button variant="ghost" :disabled="loading" @click="refreshModules">Refresh</Button>
    </template>
    <p v-if="error" class="text-f-error">{{ error }}</p>
    <div class="grid gap-4 md:grid-cols-2">
      <Card v-for="m in modules" :key="m.id" :title="m.label">
        <template #header>
          <div class="flex items-center gap-2">
            <Badge>{{ kind(m) }}</Badge>
            <Badge :tone="tone(m.status)">{{ m.status }}</Badge>
          </div>
        </template>
        <p v-if="m.description" class="text-f-text-muted">{{ m.description }}</p>
        <p v-if="m.error" class="text-f-error text-sm font-mono">{{ m.error }}</p>
        <div v-if="m.tools.length" class="flex flex-wrap gap-1.5">
          <code v-for="t in m.tools" :key="t" class="font-mono text-xs surface-inset px-2 py-0.5">{{ t }}</code>
        </div>
        <p v-else class="text-f-text-muted text-sm">No tools</p>
        <div class="flex items-center gap-3 text-xs text-f-text-muted">
          <span v-if="m.connectedAt">connected {{ new Date(m.connectedAt).toLocaleTimeString() }}</span>
          <RouterLink v-if="m.ui && m.status === 'loaded'" :to="`/m/${m.id}`" class="text-f-accent-bright hover:underline">Open</RouterLink>
          <span class="flex-1"></span>
          <Button v-if="reloadable(m)" variant="ghost" :disabled="reloading === m.id" @click="reload(m)">{{ reloading === m.id ? "Reloading…" : "Reload" }}</Button>
        </div>
      </Card>
    </div>
  </PageLayout>
</template>
