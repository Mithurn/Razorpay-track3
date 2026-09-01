import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
});
