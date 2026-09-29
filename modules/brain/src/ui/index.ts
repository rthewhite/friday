import { defineModuleUi } from "@friday/portal-ui";

export default defineModuleUi({
  id: "brain",
  nav: { label: "Brain", icon: "brain", order: 20 },
  routes: [
    { path: "", component: () => import("./BrainPage.vue") },
    { path: "p/:id", component: () => import("./PageView.vue") },
  ],
});
