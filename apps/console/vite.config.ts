import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// 隔离验收时把代理指向另一个控制面，避免动到已在运行的实例。
const api = process.env.GY_CONSOLE_API ?? "http://127.0.0.1:8877";

export default defineConfig({
  plugins: [react()],
  base: "/",
  server: {
    port: 5173,
    proxy: {
      "/chat": api,
      "/health": api,
      "/overview": api,
      "/tasks": api,
      "/settings": api,
      "/knowledge": api,
      "/today": api,
      "/memory": api,
    },
  },
  build: {
    outDir: resolve(__dirname, "../../packages/control-plane/web"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
