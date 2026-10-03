import { defineModuleUi } from "@friday/portal-ui";

export default defineModuleUi({
  id: "calendar",
  nav: { label: "Calendar", icon: "calendar", order: 30 },
  routes: [{ path: "", component: () => import("./CalendarPage.vue") }],
});
