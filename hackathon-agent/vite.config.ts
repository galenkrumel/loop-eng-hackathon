import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

// Local dev topology (mirrors the Lightbase repo): vite serves the frontend
// on 8080 and proxies the worker surfaces to `wrangler dev` on 8787. The
// /agents proxy carries the Agents SDK WebSocket (ws: true).
const WORKER_TARGET = process.env.VITE_WORKER_TARGET || "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "::",
    port: 8080,
    proxy: {
      "/agents": {
        target: WORKER_TARGET,
        changeOrigin: true,
        ws: true,
      },
      "/mcp": {
        target: WORKER_TARGET,
        changeOrigin: true,
      },
      "/api": {
        target: WORKER_TARGET,
        changeOrigin: true,
      },
      "/files": {
        target: WORKER_TARGET,
        changeOrigin: true,
      },
      "/health": {
        target: WORKER_TARGET,
        changeOrigin: true,
      },
    },
  },
});
