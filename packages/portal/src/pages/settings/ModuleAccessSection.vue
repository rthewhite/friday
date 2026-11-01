<script setup lang="ts">
/** The Access section of a module's drawer: who may use it, and the tools only the chosen users get. */
import { computed, onMounted, ref, watch } from "vue";
import { Badge, Button, Chip } from "@friday/portal-ui";
import { setModuleAccess, type ApiModule } from "../../composables/useModules.js";
import { api } from "../../composables/useApi.js";
import type { UserEntry } from "../../lib/users.js";
import { addPattern, draftOf, isNewTool, patternsOf, restrictedTools, removePattern, toggleTool, toggleUser, type AccessDraft, type ModuleAccess } from "../../lib/access.js";

const props = defineProps<{ entry: ApiModule & { access: ModuleAccess } }>();
const emit = defineEmits<{ saved: [entry: ApiModule] }>();

const users = ref<UserEntry[]>([]);
const usersError = ref<string | null>(null);
onMounted(async () => {
  try {
    users.value = (await api<{ users: UserEntry[] }>("/api/users")).users;
  } catch (e) {
    usersError.value = e instanceof Error ? e.message : String(e);
  }
});

const draft = ref<AccessDraft>(draftOf(props.entry.access));
// A saved access starts the edit over. A new entry with the same access (the module switched or reloaded) keeps the edits.
watch(() => JSON.stringify(props.entry.access), () => (draft.value = draftOf(props.entry.access)));

/** A disabled or failed module lists no tools; the ones known from the last save can still be restricted. */
const tools = computed(() => (props.entry.tools.length ? props.entry.tools : (props.entry.access.knownTools ?? [])));
const patterns = computed(() => patternsOf(draft.value, tools.value));
const restricted = computed(() => restrictedTools(tools.value, draft.value.restricted));
const newPattern = ref("");
function add() {
  draft.value = addPattern(draft.value, newPattern.value);
  newPattern.value = "";
}

const saving = ref(false);
const saveError = ref<string | null>(null);
async function save(reset: boolean) {
  saving.value = true;
  saveError.value = null;
  try {
    emit("saved", await setModuleAccess(props.entry.id, reset ? null : draft.value));
  } catch (e) {
    // The drawer keeps the edits, so they can be fixed and saved again.
    saveError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="flex flex-col gap-3" aria-label="Access">
    <h3 class="text-sm font-medium text-f-text-bright">Access</h3>
    <div class="flex flex-wrap gap-4 text-sm">
      <label class="flex items-center gap-2"><input v-model="draft.mode" type="radio" value="everyone" class="accent-f-accent" />Everyone</label>
      <label class="flex items-center gap-2"><input v-model="draft.mode" type="radio" value="chosen" class="accent-f-accent" />Chosen users</label>
    </div>

    <div>
      <h4 class="text-xs uppercase tracking-wide text-f-text-muted mb-1">Chosen users</h4>
      <p class="text-xs text-f-text-muted mb-2">
        {{ draft.mode === "chosen" ? "Only they can use this module." : "Only they get the restricted tools below." }} The household owner always can.
      </p>
      <p v-if="usersError" class="text-f-error text-sm">{{ usersError }}</p>
      <ul class="flex flex-col gap-1 text-sm">
        <li v-for="u in users" :key="u.id">
          <label class="flex items-center gap-2" :data-user="u.id">
            <input
              type="checkbox"
              class="accent-f-accent"
              :checked="u.owner || draft.users.includes(u.id)"
              :disabled="u.owner"
              @change="draft = toggleUser(draft, u.id, ($event.target as HTMLInputElement).checked)"
            />
            {{ u.name }}
            <span v-if="u.owner" class="text-f-text-muted">(owner, always included)</span>
            <span v-else-if="u.disabled" class="text-f-text-muted">(disabled)</span>
          </label>
        </li>
      </ul>
    </div>

    <div v-if="draft.mode === 'everyone'">
      <h4 class="text-xs uppercase tracking-wide text-f-text-muted mb-1">Restricted tools</h4>
      <p class="text-xs text-f-text-muted mb-2">Only the chosen users get a ticked tool. A pattern with <code class="font-mono">*</code> also catches tools added later.</p>
      <ul class="flex flex-col gap-1 text-sm">
        <li v-for="t in tools" :key="t">
          <label class="flex items-center gap-2 font-mono" :data-tool="t">
            <input
              type="checkbox"
              class="accent-f-accent"
              :checked="restricted.has(t)"
              :disabled="!draft.restricted.includes(t) && restricted.has(t)"
              @change="draft = toggleTool(draft, t, ($event.target as HTMLInputElement).checked)"
            />
            {{ t }}
            <span v-if="!draft.restricted.includes(t) && restricted.has(t)" class="font-sans text-f-text-muted">(by pattern)</span>
            <Badge v-if="isNewTool(t, entry.access)" tone="accent">new</Badge>
          </label>
        </li>
      </ul>
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        <Chip v-for="p in patterns" :key="p" class="font-mono">
          {{ p }}
          <button type="button" class="ml-1 text-f-text-muted hover:text-f-error" :aria-label="`Remove ${p}`" @click="draft = removePattern(draft, p)">×</button>
        </Chip>
      </div>
      <form class="mt-2 flex gap-2" @submit.prevent="add">
        <input v-model="newPattern" aria-label="Pattern" placeholder="HomeAssistant__*delete*" class="surface-inset flex-1 px-3 py-2 font-mono text-sm text-f-text outline-none focus:border-f-accent" />
        <Button type="submit" variant="ghost" :disabled="!newPattern.trim()">Add pattern</Button>
      </form>
    </div>

    <p v-if="saveError" class="text-f-error text-sm">{{ saveError }}</p>
    <div class="flex gap-2">
      <Button :disabled="saving" @click="save(false)">{{ saving ? "Saving…" : "Save" }}</Button>
      <Button variant="ghost" :disabled="saving" @click="save(true)">Reset to everyone</Button>
    </div>
  </section>
</template>
