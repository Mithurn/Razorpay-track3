import Fastify from "fastify";

// Scaffold entry point. Day 1 wires the real server: the recovery worker (BullMQ), the
// Mastra agent, the case/queue/run endpoints, and the SSE stream. See context/PROJECT.md.

const port = Number(process.env.PORT ?? 3000);

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok" }));

app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
