// For the host's uptime ping. Says nothing about the business.

import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", { config: { access: "public" } }, async (_request, reply) => {
    const database = await app.ctx.db.ping();
    return reply.status(database ? 200 : 503).send({ ok: database });
  });
}
