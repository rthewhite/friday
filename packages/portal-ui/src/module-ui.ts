import type { RouteRecordRaw } from "vue-router";

export interface ModuleNav {
  label: string;
  /** Icon name from portal-ui (mic, grid, play, settings, key, server, link) or short text/emoji fallback. */
  icon?: string;
  /** Lower sorts first; ties sort by label. */
  order?: number;
}

export interface ModuleUi {
  /** Must equal the module manifest id. */
  id: string;
  nav: ModuleNav;
  /** Route records relative to `/m/<id>`; use `""` for the index page. */
  routes: RouteRecordRaw[];
}

/** Identity helper giving module authors type checking for their UI declaration. */
export const defineModuleUi = (ui: ModuleUi): ModuleUi => ui;
