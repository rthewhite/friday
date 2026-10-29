<script setup lang="ts">
import { computed } from "vue";
import { PageLayout, Card } from "@friday/portal-ui";
import { useModules } from "../composables/useModules.js";
import { useSession } from "../composables/useSession.js";

const props = defineProps<{ id: string }>();
const { modules, loading, isEnabled } = useModules();
const moduleId = computed(() => props.id.split("/")[0] ?? props.id);
const entry = computed(() => modules.value.find((m) => m.id === moduleId.value));
// The Modules page is for admins; a member following the link would only get the admin-only notice.
const { me } = useSession();
const isAdmin = computed(() => me.value?.role === "admin");
</script>

<template>
  <RouterView v-if="isEnabled(moduleId)" />
  <PageLayout v-else eyebrow="Modules" :title="entry?.label ?? moduleId" subtitle="Module not available">
    <Card>
      <p v-if="loading" class="text-f-text-muted">Checking module status…</p>
      <template v-else>
        <p>
          The module <code class="font-mono">{{ moduleId }}</code>
          <span v-if="!entry"> is not part of this deployment.</span>
          <span v-else-if="entry.status === 'disabled'"> is turned off for this Friday.</span>
          <span v-else-if="entry.status === 'failed'"> failed to load: <span class="text-f-error">{{ entry.error }}</span></span>
          <span v-else-if="!entry.ui"> has no page of its own.</span>
          <span v-else> is not enabled.</span>
        </p>
        <RouterLink v-if="isAdmin" to="/settings/modules" class="text-f-accent-bright hover:underline">See all modules</RouterLink>
      </template>
    </Card>
  </PageLayout>
</template>
