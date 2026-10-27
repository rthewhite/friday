import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";
import { createPortalRouter } from "./router.js";
import { moduleUis } from "./modules.gen.js";
import { guardFetch, loadMe, loginUrl } from "./lib/auth.js";
import { loginGuard, me } from "./composables/useSession.js";

/** A page shown instead of the portal when it can't start for this user. */
function stopWith(title: string, message: string): void {
  const app = document.querySelector("#app")!;
  app.innerHTML = `<main class="min-h-screen grid place-items-center p-8"><div class="max-w-md flex flex-col gap-3"><h1 class="text-lg font-semibold text-f-text-bright"></h1><p class="text-f-text-muted"></p><a class="text-f-accent-bright" href="/auth/login">Log in again</a></div></main>`;
  app.querySelector("h1")!.textContent = title;
  app.querySelector("p")!.textContent = message;
}

async function bootstrap() {
  // Who is this? Before anything renders, so a member never sees the admin pages, even briefly.
  const boot = await loadMe(fetch.bind(window), sessionStorage);
  if (boot.kind === "login") return location.assign(loginUrl(location.pathname + location.search + location.hash));
  if (boot.kind === "loop") {
    return stopWith("Logging in didn't work", "You were sent to the login and came back without a session. The session cookie wasn't kept: check that FRIDAY_PUBLIC_URL is the address you opened Friday at.");
  }
  if (boot.kind === "error") return stopWith("Friday can't be reached", `Loading your account failed (${boot.message}). Try again in a moment.`);
  me.value = boot.me;
  // From here on, any 401 from the API means the session ended: go to the login (after a streaming reply finishes).
  window.fetch = guardFetch(window.fetch.bind(window), loginGuard, location.origin);

  const uis = (await Promise.all(moduleUis.map((load) => load()))).map((m) => m.default);
  const router = createPortalRouter(uis);
  const app = createApp(App);
  app.provide("moduleUis", uis);
  app.use(router);
  try {
    await router.isReady();
  } catch {
    // The first page could not load (the router's error handler logged it): show the shell anyway, so the sidebar
    // still works instead of a blank tab.
  }
  app.mount("#app");
}

void bootstrap();
