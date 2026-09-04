import type { FastifyReply, FastifyRequest } from "fastify";

const KEEP_ALIVE_MS = 15_000;

// Subscribe before the snapshot read, so an event landing during that read is never missed.
export function openSse(
  req: FastifyRequest,
  reply: FastifyReply,
  openEvent: unknown,
  subscribe: (send: (event: unknown) => void) => () => void,
  snapshot: (send: (event: unknown) => void) => Promise<void>,
): void {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  send(openEvent);

  const unsubscribe = subscribe(send);
  void snapshot(send);

  const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), KEEP_ALIVE_MS);
  req.raw.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}
