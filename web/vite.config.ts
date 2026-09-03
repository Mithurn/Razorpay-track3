import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  root: __dirname,
  // The real .env lives at the repo root, one level up from root — without this Vite looks for
  // VITE_-prefixed vars inside web/ and silently bakes in nothing.
  envDir: resolve(__dirname, ".."),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
});
