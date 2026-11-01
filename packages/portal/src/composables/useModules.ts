import { ref } from "vue";
import { hasPage, withEntry } from "../lib/modules.js";
import { api } from "./useApi.js";
import { accessBody, type AccessDraft, type ModuleAccess } from "../lib/access.js";

export interface ApiModule {
  id: string;
  label: string;
  description?: string;
  status: "loaded" | "failed" | "disabled" | "connected";
  error?: string;
  tools: string[];
  ui?: boolean;
  connectedAt?: string;
  /** Whether the logged-in user may use the module. Members are only sent the ones they may. */
  available?: boolean;
  /** Who may use it; sent to admins for every module but core and builtin. */
  access?: ModuleAccess;
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

/**
 * Switch an in-process module on or off. The server answers with the module's new entry (loaded, failed with its
 * error, or disabled), which replaces the shared one, so the sidebar and the module pages follow at once. Rejects
 * with the server's error, leaving the list as it was.
 */
export async function setModuleEnabled(id: string, enabled: boolean): Promise<ApiModule> {
  const entry = await api<ApiModule>(`/api/modules/${encodeURIComponent(id)}/enabled`, { method: "PUT", json: { enabled } });
  modules.value = withEntry(modules.value, entry);
  return entry;
}

/**
 * Save who may use a module (`draft`), or go back to everyone (`null`). The server answers with the module's new
 * entry, which replaces the shared one. Rejects with the server's error, leaving the list as it was.
 */
export async function setModuleAccess(id: string, draft: AccessDraft | null): Promise<ApiModule> {
  const path = `/api/modules/${encodeURIComponent(id)}/access`;
  const entry = await api<ApiModule>(path, draft ? { method: "PUT", json: accessBody(draft) } : { method: "DELETE" });
  modules.value = withEntry(modules.value, entry);
  return entry;
}

export function useModules() {
  if (!modules.value.length && !loading.value) void refreshModules();
  /** The module's page can be shown (see hasPage): core's own entry has none. */
  const isEnabled = (id: string) => modules.value.some((m) => m.id === id && hasPage(m));
  return { modules, loading, error, refreshModules, isEnabled, setModuleEnabled, setModuleAccess };
}
