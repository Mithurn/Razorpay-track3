import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Integration tests read DATABASE_URL / ADMIN_DATABASE_URL; vitest has no --env-file flag.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
