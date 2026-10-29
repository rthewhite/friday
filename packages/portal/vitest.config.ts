import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// Component tests only (test/components/). Everything else in test/ runs under node:test, which can't load .vue files.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: ["vue", "vue-router"],
  },
  test: {
    environment: "happy-dom",
    include: ["test/components/**/*.test.ts"],
  },
});
