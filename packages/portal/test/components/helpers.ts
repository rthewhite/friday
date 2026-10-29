/** Shared set-up for the component tests (vitest + @vue/test-utils + happy-dom). */
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { flushPromises, type VueWrapper } from "@vue/test-utils";

const Blank = { render: () => null };

/** A router at `path`, with catch-all pages so navigations away resolve. */
export async function routerAt(path: string): Promise<Router> {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:any(.*)*", component: Blank }] });
  await router.push(path);
  await router.isReady();
  return router;
}

export type ApiCall = { path: string; method: string; json?: unknown };
export type ApiRoutes = Record<string, unknown | ((call: ApiCall) => unknown)>;

/**
 * A fake `api()` that answers by `"METHOD /path"` and records each call. A handler may throw, as `api()` does for an
 * error response; an unknown route throws a 404.
 */
export function fakeApi(routes: ApiRoutes) {
  const calls: ApiCall[] = [];
  const api = async (path: string, init?: { method?: string; json?: unknown }) => {
    const call: ApiCall = { path, method: init?.method ?? "GET", ...(init?.json !== undefined && { json: init.json }) };
    calls.push(call);
    const route = routes[`${call.method} ${path}`];
    if (route === undefined) throw new Error(`404 ${call.method} ${path}`);
    return typeof route === "function" ? (route as (c: ApiCall) => unknown)(call) : structuredClone(route);
  };
  return { api, calls };
}

/** The `<input>` inside the `<label>` whose text starts with `label`. */
export function field(w: VueWrapper, label: string) {
  const l = w.findAll("label").find((x) => x.text().startsWith(label));
  if (!l) throw new Error(`no field labelled ${label}`);
  return l.find("input");
}

/** The button whose text is `text`. */
export function button(w: VueWrapper, text: string) {
  const b = w.findAll("button").find((x) => x.text().trim() === text);
  if (!b) throw new Error(`no button ${text}; have: ${w.findAll("button").map((x) => x.text().trim()).join(" | ")}`);
  return b;
}

export { flushPromises };
