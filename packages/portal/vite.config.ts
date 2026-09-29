import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

const core = process.env.FRIDAY_CORE_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    // Module UIs resolve vue and vue-router from their own packages; pnpm may link different copies
    // (e.g. per TypeScript peer). One copy each keeps useRoute/useRouter and reactivity shared with the shell.
    dedupe: ["vue", "vue-router"],
  },
  server: {
    port: 5173,
    // Keep the browser's Host header (the string shorthand would set changeOrigin): core refuses
    // API writes whose Origin differs from Host, so a rewritten Host would 403 every portal write.
    proxy: {
      "/api": { target: core, changeOrigin: false },
      "/health": { target: core, changeOrigin: false },
      "/ws": { target: core, ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
