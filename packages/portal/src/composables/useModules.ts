import { ref } from "vue";
import { hasPage } from "../lib/modules.js";

export interface ApiModule {
  id: string;
  label: string;
  description?: string;
  status: "loaded" | "failed" | "disabled" | "connected";
  error?: string;
  tools: string[];
  ui?: boolean;
  connectedAt?: string;
}

const modules = ref<ApiModule[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

export async function refreshModules(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetch("/api/modules");
    if (!res.ok) throw new Error(`/api/modules -> ${res.status}`);
    modules.value = (await res.json()) as ApiModule[];
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

export function useModules() {
  if (!modules.value.length && !loading.value) void refreshModules();
  /** The module's page can be shown (see hasPage): core's own entry has none. */
  const isEnabled = (id: string) => modules.value.some((m) => m.id === id && hasPage(m));
  return { modules, loading, error, refreshModules, isEnabled };
}
