import { defineModuleUi } from "@friday/portal-ui";

export default defineModuleUi({
  id: "media",
  nav: { label: "Media", icon: "play", order: 10 },
  routes: [{ path: "", component: () => import("./MediaPage.vue") }],
});
