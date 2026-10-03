// For the host's uptime ping. Says nothing about the business.

import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", { config: { access: "public" } }, async (_request, reply) => {
    const database = await app.ctx.db.ping();
    // The checks that run after every save. A failure here never stops a
    // save, so this is where it shows.
    const checks = !app.ctx.checks.failing;
    return reply.status(database && checks ? 200 : 503).send({ ok: database && checks, database, checks });
  });
}
