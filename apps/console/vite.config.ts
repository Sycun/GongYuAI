import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "/",
  server: {
    port: 5173,
    proxy: {
      "/health": "http://127.0.0.1:8877",
      "/overview": "http://127.0.0.1:8877",
      "/tasks": "http://127.0.0.1:8877",
    },
  },
  build: {
    outDir: resolve(__dirname, "../../packages/control-plane/web"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
