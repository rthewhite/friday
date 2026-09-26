import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

const core = process.env.FRIDAY_CORE_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      "/api": core,
      "/health": core,
      "/ws": { target: core, ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
