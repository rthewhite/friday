<script setup lang="ts">
import { computed } from "vue";
import { PageLayout, Card } from "@friday/portal-ui";
import { useModules } from "../composables/useModules.js";

const props = defineProps<{ id: string }>();
const { modules, loading, isEnabled } = useModules();
const moduleId = computed(() => props.id.split("/")[0] ?? props.id);
const entry = computed(() => modules.value.find((m) => m.id === moduleId.value));
</script>

<template>
  <RouterView v-if="isEnabled(moduleId)" />
  <PageLayout v-else :title="entry?.label ?? moduleId" subtitle="Module not enabled">
    <Card>
      <p v-if="loading" class="text-f-text-muted">Checking module status…</p>
      <template v-else>
        <p>
          The module <code class="font-mono">{{ moduleId }}</code>
          <span v-if="!entry"> is not part of this deployment.</span>
          <span v-else-if="entry.status === 'disabled'"> is disabled by <code class="font-mono">FRIDAY_MODULES</code>.</span>
          <span v-else-if="entry.status === 'failed'"> failed to load: <span class="text-f-error">{{ entry.error }}</span></span>
          <span v-else> is not enabled.</span>
        </p>
        <RouterLink to="/modules" class="text-f-accent-bright hover:underline">See all modules</RouterLink>
      </template>
    </Card>
  </PageLayout>
</template>
