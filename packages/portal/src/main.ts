import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";
import { createPortalRouter } from "./router.js";
import { moduleUis } from "./modules.gen.js";

async function bootstrap() {
  const uis = (await Promise.all(moduleUis.map((load) => load()))).map((m) => m.default);
  const router = createPortalRouter(uis);
  const app = createApp(App);
  app.provide("moduleUis", uis);
  app.use(router);
  await router.isReady();
  app.mount("#app");
}

void bootstrap();
