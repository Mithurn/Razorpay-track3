import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const aegis = process.env.AEGIS_URL ?? "http://localhost:3000";
const catalog = process.env.CATALOG_URL ?? "http://localhost:4000";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: aegis, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
      "/catalog": { target: catalog, changeOrigin: true },
    },
  },
});
