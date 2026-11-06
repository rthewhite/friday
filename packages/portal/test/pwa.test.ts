import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import vm from "node:vm";
import { ICONS, drawMark, encodePng } from "../scripts/gen-icons.mjs";
import { registerServiceWorker } from "../src/lib/pwa.ts";

const pub = (p: string) => fileURLToPath(new URL(`../public/${p.replace(/^\//, "")}`, import.meta.url));
const indexHtml = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

/** Width, height and colour type from a PNG's IHDR chunk. */
function pngHeader(buf: Buffer) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  assert.equal(buf.subarray(12, 16).toString("ascii"), "IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colourType: buf[25] };
}

/** The unfiltered pixel rows of a PNG written by the generator (one IDAT chunk, filter 0 per row). */
function pngRows(buf: Buffer): Buffer {
  const len = buf.readUInt32BE(33);
  assert.equal(buf.subarray(37, 41).toString("ascii"), "IDAT");
  return inflateSync(buf.subarray(41, 41 + len));
}

// ---- manifest, icons and page tags ------------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(pub("manifest.webmanifest"), "utf8"));

test("the manifest names the app Friday and opens it standalone at /", () => {
  assert.equal(manifest.name, "Friday");
  assert.equal(manifest.short_name, "Friday");
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  // --color-f-bg, the portal's background.
  assert.equal(manifest.background_color, "#0f1217");
  assert.equal(manifest.theme_color, "#0f1217");
});

test("the manifest lists 192 and 512 px icons and a 512 px maskable one", () => {
  const sized = (sizes: string, purpose?: string) => manifest.icons.find((i: { sizes: string; purpose?: string }) => i.sizes === sizes && i.purpose === purpose);
  assert.ok(sized("192x192"), "192 px icon");
  assert.ok(sized("512x512"), "512 px icon");
  assert.ok(sized("512x512", "maskable"), "maskable icon");
});

test("every icon the manifest lists is a PNG of the size it states", () => {
  for (const icon of manifest.icons as { src: string; sizes: string; type: string }[]) {
    assert.equal(icon.type, "image/png");
    const [w, h] = icon.sizes.split("x").map(Number);
    const head = pngHeader(readFileSync(pub(icon.src)));
    assert.deepEqual([head.width, head.height], [w, h], icon.src);
  }
});

test("the iOS home-screen icon is a 180 px PNG", () => {
  const head = pngHeader(readFileSync(pub("icons/apple-touch-icon.png")));
  assert.deepEqual([head.width, head.height], [180, 180]);
});

test("the committed icons are what the generator draws", () => {
  // Pixels, not bytes: another zlib may compress the same pixels differently.
  for (const icon of ICONS) {
    const committed = pngRows(readFileSync(pub(`icons/${icon.file}`)));
    assert.ok(committed.equals(pngRows(encodePng(icon.size, icon.size, drawMark(icon.size, icon.rounded)))), `${icon.file}: run node scripts/gen-icons.mjs`);
  }
});

test("the generator's PNG decodes to the mark: transparent rounded corners, the accent, and a white F", () => {
  const size = 64;
  const png = encodePng(size, size, drawMark(size, true));
  const head = pngHeader(png);
  assert.deepEqual([head.width, head.height, head.colourType], [size, size, 6]);
  const rows = pngRows(png);
  const pixel = (x: number, y: number) => [...rows.subarray(y * (size * 4 + 1) + 1 + x * 4, y * (size * 4 + 1) + 1 + x * 4 + 4)];
  assert.equal(pixel(0, 0)[3], 0, "corner is transparent");
  assert.deepEqual(pixel(6, 32), [0x3b, 0x82, 0xf6, 255], "background is the accent");
  assert.deepEqual(pixel(25, 32), [255, 255, 255, 255], "stem is white");
  // The maskable variant fills the square.
  const full = drawMark(size, false);
  assert.equal(full[3], 255, "maskable corner is filled");
});

test("every page links the manifest and icons and declares the theme colour and iOS app title", () => {
  const has = (re: RegExp, what: string) => assert.match(indexHtml, re, what);
  has(/<link rel="manifest" href="\/manifest\.webmanifest" \/>/, "manifest");
  has(/<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" \/>/, "favicon");
  has(/<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png" \/>/, "iOS icon");
  has(/<meta name="theme-color" content="#0f1217" \/>/, "theme colour");
  has(/<meta name="apple-mobile-web-app-title" content="Friday" \/>/, "iOS title");
  has(/<meta name="mobile-web-app-capable" content="yes" \/>/, "standalone");
  assert.match(readFileSync(pub("favicon.svg"), "utf8"), /^<svg [^>]*viewBox="0 0 100 100"/);
});

test("the viewport covers the safe areas, resizes for the keyboard and leaves pinch zoom alone", () => {
  const viewport = indexHtml.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? "";
  assert.match(viewport, /viewport-fit=cover/);
  assert.match(viewport, /interactive-widget=resizes-content/);
  assert.doesNotMatch(viewport, /maximum-scale|user-scalable/);
});

// ---- the service worker ------------------------------------------------------------------------------------------

const ORIGIN = "https://friday.example";
type Listener = (event: FakeEvent) => void;
interface FakeEvent {
  request?: { url: string; mode: string; method: string };
  preloadResponse?: Promise<unknown>;
  responded?: Promise<unknown>;
  waited?: Promise<unknown>;
  respondWith(p: Promise<unknown>): void;
  waitUntil(p: Promise<unknown>): void;
}

/** Load public/sw.js in a sandbox with fake caches and fetch. `online` decides whether fetch answers. */
function worker(opts: { online: boolean; caches?: string[]; preload?: boolean }) {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, string>>((opts.caches ?? []).map((name) => [name, new Map()]));
  const fetched: string[] = [];
  const calls = { skipWaiting: 0, claim: 0, preloadEnabled: 0 };
  const fetchFn = async (input: string | { url: string }) => {
    const url = typeof input === "string" ? new URL(input, ORIGIN).href : input.url;
    fetched.push(url);
    if (!opts.online) throw new TypeError("Failed to fetch");
    return { from: "network", url };
  };
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return { add: async (path: string) => { await fetchFn(path); store.set(path, `cached ${path}`); } };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (path: string, o?: { cacheName?: string }) => {
      const store = o?.cacheName ? stores.get(o.cacheName) : [...stores.values()].find((s) => s.has(path));
      return store?.get(path);
    },
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: async () => void calls.skipWaiting++,
    clients: { claim: async () => void calls.claim++ },
    // Browsers without navigation preload have no navigationPreload.
    registration: opts.preload === false ? {} : { navigationPreload: { enable: async () => void calls.preloadEnabled++ } },
  };
  const context = vm.createContext({ self, caches, fetch: fetchFn, URL, Response: { error: () => "network error" }, console });
  vm.runInContext(readFileSync(pub("sw.js"), "utf8"), context);
  const dispatch = (type: string, request?: FakeEvent["request"], preloadResponse?: Promise<unknown>) => {
    const event: FakeEvent = {
      request,
      preloadResponse,
      respondWith(p) { this.responded = p; },
      waitUntil(p) { this.waited = p; },
    };
    listeners.get(type)!(event);
    return event;
  };
  const navigate = (path: string, init: Partial<NonNullable<FakeEvent["request"]>> = {}, preloadResponse?: Promise<unknown>) =>
    dispatch("fetch", { url: new URL(path, ORIGIN).href, mode: "navigate", method: "GET", ...init }, preloadResponse);
  return { dispatch, navigate, stores, fetched, calls };
}

test("installing caches only the offline page and takes over at once", async () => {
  const sw = worker({ online: true });
  await sw.dispatch("install").waited;
  assert.deepEqual([...sw.stores.keys()], ["friday-offline-v1"]);
  assert.deepEqual([...sw.stores.get("friday-offline-v1")!.keys()], ["/offline.html"]);
  assert.equal(sw.calls.skipWaiting, 1);
});

test("activating drops older friday caches, keeps others, and claims open pages", async () => {
  const sw = worker({ online: true, caches: ["friday-offline-v0", "friday-offline-v1", "someone-else"] });
  await sw.dispatch("activate").waited;
  assert.deepEqual([...sw.stores.keys()].sort(), ["friday-offline-v1", "someone-else"]);
  assert.equal(sw.calls.claim, 1);
  assert.equal(sw.calls.preloadEnabled, 1, "navigation preload on");
});

test("activating works in a browser without navigation preload", async () => {
  const sw = worker({ online: true, preload: false });
  await sw.dispatch("activate").waited;
  assert.equal(sw.calls.claim, 1);
});

test("a page load uses the preloaded response, without a second request", async () => {
  const sw = worker({ online: true });
  const event = sw.navigate("/chat", {}, Promise.resolve({ from: "preload" }));
  assert.deepEqual(await event.responded, { from: "preload" });
  assert.deepEqual(sw.fetched, []);
});

test("a failed preload, offline, gets the offline page", async () => {
  const sw = worker({ online: false });
  sw.stores.set("friday-offline-v1", new Map([["/offline.html", "cached /offline.html"]]));
  const event = sw.navigate("/chat", {}, Promise.reject(new TypeError("Failed to fetch")));
  assert.equal(await event.responded, "cached /offline.html");
});

test("a page opened online comes from the network, and nothing is stored", async () => {
  const sw = worker({ online: true });
  await sw.dispatch("install").waited;
  const event = sw.navigate("/chat/abc");
  assert.deepEqual(await event.responded, { from: "network", url: `${ORIGIN}/chat/abc` });
  assert.deepEqual([...sw.stores.get("friday-offline-v1")!.keys()], ["/offline.html"]);
});

test("a page opened offline gets the offline page", async () => {
  const online = worker({ online: true });
  await online.dispatch("install").waited;
  // The same worker code, now without a network, with the cache from the install.
  const sw = worker({ online: false });
  sw.stores.set("friday-offline-v1", online.stores.get("friday-offline-v1")!);
  assert.equal(await sw.navigate("/").responded, "cached /offline.html");
  assert.equal(await sw.navigate("/settings/config?tab=secrets").responded, "cached /offline.html");
});

test("without the offline page in the cache, an offline page load fails as a network error", async () => {
  const sw = worker({ online: false });
  assert.equal(await sw.navigate("/chat").responded, "network error");
});

test("the API, the login, WebSockets, health, code and other sites are left to the browser", () => {
  const sw = worker({ online: false });
  const untouched = [
    sw.dispatch("fetch", { url: `${ORIGIN}/api/modules`, mode: "cors", method: "GET" }),
    sw.navigate("/api/modules"),
    sw.navigate("/auth/login"),
    sw.navigate("/auth/callback?code=x"),
    sw.navigate("/auth"),
    sw.navigate("/ws/audio"),
    sw.navigate("/health"),
    sw.dispatch("fetch", { url: `${ORIGIN}/assets/ChatPage-BV3rT8Xw.js`, mode: "cors", method: "GET" }),
    sw.dispatch("fetch", { url: `${ORIGIN}/assets/index-BrJRoGJ8.css`, mode: "no-cors", method: "GET" }),
    sw.dispatch("fetch", { url: `${ORIGIN}/manifest.webmanifest`, mode: "cors", method: "GET" }),
    sw.navigate("https://auth.example/application/o/authorize/"),
    sw.navigate("/chat", { method: "POST" }),
  ];
  for (const e of untouched) assert.equal(e.responded, undefined, e.request?.url);
  assert.deepEqual(sw.fetched, []);
});

test("paths that only start like a reserved one are still pages", () => {
  const sw = worker({ online: true });
  assert.ok(sw.navigate("/authors").responded, "/authors is not /auth");
  assert.ok(sw.navigate("/apiary").responded, "/apiary is not /api");
});

// ---- registering it ----------------------------------------------------------------------------------------------

function fakeNavigator(result: "ok" | Error) {
  const registered: { url: string; scope: string }[] = [];
  const nav = {
    serviceWorker: {
      register: async (url: string, o: { scope: string }) => {
        registered.push({ url, scope: o.scope });
        if (result instanceof Error) throw result;
        return {};
      },
    },
  };
  return { nav, registered };
}
const quiet = () => {
  const warned: unknown[][] = [];
  return { log: { warn: (...args: unknown[]) => void warned.push(args) }, warned };
};

test("a build for deployment registers /sw.js for the whole portal", async () => {
  const { nav, registered } = fakeNavigator("ok");
  assert.equal(await registerServiceWorker(nav, true), true);
  assert.deepEqual(registered, [{ url: "/sw.js", scope: "/" }]);
});

test("the dev server registers no service worker", async () => {
  const { nav, registered } = fakeNavigator("ok");
  assert.equal(await registerServiceWorker(nav, false), false);
  assert.deepEqual(registered, []);
});

test("a browser without service workers is left alone", async () => {
  assert.equal(await registerServiceWorker({}, true), false);
});

test("a failed registration is logged and not thrown", async () => {
  const { nav } = fakeNavigator(new DOMException("The operation is insecure.", "SecurityError"));
  const { log, warned } = quiet();
  assert.equal(await registerServiceWorker(nav, true, log), false);
  assert.equal(warned.length, 1);
  assert.match(String(warned[0]![0]), /service worker/);
});

test("the offline page loads nothing else and needs no script", () => {
  const html = readFileSync(pub("offline.html"), "utf8");
  assert.doesNotMatch(html, /<(script|link|img|iframe)\b/i);
  assert.doesNotMatch(html, /\bsrc=|url\(|\bon[a-z]+=/i);
  assert.match(html, /Friday can't be reached/);
  assert.match(html, /<a class="retry" href="">Retry<\/a>/);
});
