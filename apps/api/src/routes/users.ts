// The CEO's account and the devices signed in to it.
//
//   GET    /v1/users          The account and its signed-in devices
//   DELETE /v1/sessions/:id   Sign out a device
//
// No account is added here: the system is the CEO's alone. His account is
// made once, by whoever sets the system up, and the same command gives him a
// new password if he loses his: `pnpm --filter @green-star/api create-ceo`.

import { IdParams, type UserList, type UserWithSessions } from "@green-star/contracts";
import type { FastifyInstance } from "fastify";
import { authOf } from "../app.ts";
import { toUser, type UserRow } from "../auth/sessions.ts";
import type { Queryable } from "../db.ts";
import { notFound, parse } from "../errors.ts";
import { write } from "../http.ts";

interface UserListRow extends UserRow {
  created_at: Date;
  has_password: boolean;
}

interface SessionListRow {
  [key: string]: unknown;
  id: string;
  user_id: string;
  device: string | null;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

/** Accounts that are switched off are not listed: they can do nothing, and nothing here can change them. */
async function listUsers(q: Queryable, currentSessionId: string): Promise<UserWithSessions[]> {
  const users = await q.query<UserListRow>(
    `select u.id, u.name, u.phone, u.active, u.created_at,
            exists (select 1 from user_credentials c where c.user_id = u.id) as has_password
     from users u
     where u.active
     order by u.created_at, u.id`,
  );
  const sessions = await q.query<SessionListRow>(
    `select id, user_id, device, created_at, last_seen_at, expires_at
     from sessions
     where revoked_at is null and expires_at > now()
     order by last_seen_at desc`,
  );
  return users.map((row) => ({
    ...toUser(row),
    createdAt: row.created_at.toISOString(),
    hasPassword: row.has_password,
    sessions: sessions
      .filter((s) => s.user_id === row.id)
      .map((s) => ({
        id: s.id,
        device: s.device,
        createdAt: s.created_at.toISOString(),
        lastSeenAt: s.last_seen_at.toISOString(),
        expiresAt: s.expires_at.toISOString(),
        current: s.id === currentSessionId,
      })),
  }));
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  app.get("/users", { config: { access: "signed_in" } }, async (request): Promise<UserList> => {
    const auth = authOf(request);
    return { users: await db.read((q) => listUsers(q, auth.sessionId)) };
  });

  app.delete("/sessions/:id", { config: { access: "signed_in" } }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    await write(app.ctx, request, reply, async ({ q, auth }) => {
      const found = await q.first("select id from sessions where id = $1", [id]);
      if (found === undefined) throw notFound("That device");
      await q.query("update sessions set revoked_at = now(), revoked_by = $2 where id = $1 and revoked_at is null", [
        id,
        auth.user.id,
      ]);
      return { status: 204, body: null };
    });
    return reply.send();
  });
}
