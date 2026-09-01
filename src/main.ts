import Fastify from "fastify";
import { loadConfig } from "./config.js";

/**
 * Composition root. Wire dependencies here and nowhere else:
 *   config -> pg pool -> repositories -> razorpay client -> attempt executor
 *          -> recovery agent -> safety gate -> recovery worker (BullMQ)
 *          -> Fastify server (routes + SSE)
 *
 * Everything below the composition root depends on interfaces, not on pg / Razorpay
 * SDK / BullMQ directly. See CLAUDE.md for the layering rules.
 */

const config = loadConfig();
const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok" }));

await app.listen({ port: config.PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
