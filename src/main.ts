import Fastify from "fastify";
import { loadConfig } from "./config.js";

// Composition root. Dependencies are wired here and nowhere else. Everything below the root
// depends on interfaces, not on pg / the Razorpay SDK / BullMQ directly. See CLAUDE.md.

const config = loadConfig();
const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok" }));

await app.listen({ port: config.PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
