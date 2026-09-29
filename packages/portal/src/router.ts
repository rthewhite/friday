import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import type { ModuleUi } from "@friday/portal-ui";

export function createPortalRouter(uis: ModuleUi[]) {
  const routes: RouteRecordRaw[] = [
    { path: "/", name: "talk", component: () => import("./pages/TalkPage.vue") },
    // `/chat/:id` is a child so the `/chat` nav item stays active on every thread.
    { path: "/chat", name: "chat", component: () => import("./pages/ChatPage.vue"), children: [{ path: ":id", name: "chat-thread", component: { render: () => null } }] },
    { path: "/conversations", name: "conversations", component: () => import("./pages/ConversationsPage.vue") },
    { path: "/modules", name: "modules", component: () => import("./pages/ModulesPage.vue") },
    { path: "/settings/config", name: "settings-config", component: () => import("./pages/settings/ConfigurationPage.vue") },
    { path: "/settings/keys", name: "settings-keys", component: () => import("./pages/settings/RemoteModulesPage.vue") },
    { path: "/settings/jobs", name: "settings-jobs", component: () => import("./pages/settings/JobsPage.vue") },
    ...uis.map<RouteRecordRaw>((ui) => ({
      path: `/m/${ui.id}`,
      component: () => import("./shell/ModuleGate.vue"),
      props: { id: ui.id },
      children: ui.routes.map((r) => ({ ...r, path: String(r.path).replace(/^\//, "") })),
    })),
    { path: "/m/:id(.*)", component: () => import("./shell/ModuleGate.vue"), props: true },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ];
  return createRouter({ history: createWebHistory(), routes });
}
