// The accounts the CEO adds, and the devices signed in to them.
//
//   GET    /v1/users          CEO   Every account and its signed-in devices
//   POST   /v1/users          CEO   Add the owner or a monitor account
//   PATCH  /v1/users/:id      CEO   Rename, switch off or on, set a password
//   DELETE /v1/sessions/:id   CEO   Sign out a device
//
// The first CEO is not added here. He is created once, by whoever sets the
// system up: `pnpm --filter @green-star/api create-ceo`.

import {
  CEO_ONLY,
  IdParams,
  NewUserRequest,
  UpdateUserRequest,
  type UserList,
  type UserWithSessions,
} from "@green-star/contracts";
import { normalizePhone } from "@green-star/domain";
import type { FastifyInstance } from "fastify";
import { authOf } from "../app.ts";
import { hashPassword } from "../auth/passwords.ts";
import { endSessions, toUser, type UserRow } from "../auth/sessions.ts";
import type { Queryable } from "../db.ts";
import { ApiError, notFound, parse } from "../errors.ts";
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

async function listUsers(q: Queryable, currentSessionId: string, onlyId: string | null = null): Promise<UserWithSessions[]> {
  const users = await q.query<UserListRow>(
    `select u.id, u.name, u.role, u.phone, u.sign_in_name, u.active, u.created_at,
            exists (select 1 from user_credentials c where c.user_id = u.id) as has_password
     from users u
     where $1::uuid is null or u.id = $1
     order by array_position(array['ceo', 'owner', 'monitor']::user_role[], u.role), u.created_at`,
    [onlyId],
  );
  const sessions = await q.query<SessionListRow>(
    `select id, user_id, device, created_at, last_seen_at, expires_at
     from sessions
     where revoked_at is null and expires_at > now() and ($1::uuid is null or user_id = $1)
     order by last_seen_at desc`,
    [onlyId],
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
  const { db, config } = app.ctx;

  app.get("/users", { config: { access: CEO_ONLY } }, async (request): Promise<UserList> => {
    const auth = authOf(request);
    return { users: await db.read((q) => listUsers(q, auth.sessionId)) };
  });

  app.post("/users", { config: { access: CEO_ONLY } }, async (request, reply): Promise<UserWithSessions> => {
    const body = parse(NewUserRequest, request.body);

    let phone: string | null = null;
    if (body.role === "owner") {
      phone = normalizePhone(body.phone);
      if (phone === null) {
        throw new ApiError(400, "invalid_request", "phone: That is not a phone number", {
          fields: { phone: "That is not a phone number" },
        });
      }
    }
    const signInName = body.role === "monitor" ? body.signInName : null;
    const hash = await hashPassword(body.password, config.scrypt);

    return write(app.ctx, request, reply, async ({ q, auth }) => {
      const id = await q.value<string>(
        `insert into users (name, role, phone, sign_in_name, created_by) values ($1, $2, $3, $4, $5) returning id`,
        [body.name, body.role, phone, signInName, auth.user.id],
      );
      await q.query("insert into user_credentials (user_id, password_hash) values ($1, $2)", [id, hash]);
      const created = (await listUsers(q, auth.sessionId, id))[0];
      if (created === undefined) throw new Error("the user was not created");
      return { status: 201, body: created };
    });
  });

  app.patch("/users/:id", { config: { access: CEO_ONLY } }, async (request, reply): Promise<UserWithSessions> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(UpdateUserRequest, request.body);
    const hash = body.password === undefined ? null : await hashPassword(body.password, config.scrypt);

    return write(app.ctx, request, reply, async ({ q, auth }) => {
      const found = await q.first("select id from users where id = $1 for update", [id]);
      if (found === undefined) throw notFound("That user");

      if (body.name !== undefined || body.active !== undefined) {
        await q.query("update users set name = coalesce($2, name), active = coalesce($3, active) where id = $1", [
          id,
          body.name ?? null,
          body.active ?? null,
        ]);
      }
      if (hash !== null) {
        await q.query(
          `insert into user_credentials (user_id, password_hash) values ($1, $2)
           on conflict (user_id) do update set password_hash = excluded.password_hash`,
          [id, hash],
        );
      }
      // Switched off, or given a new password: signed out everywhere. The
      // CEO changing his own password here keeps the device he is on.
      if (body.active === false || hash !== null) {
        await endSessions(q, id, auth.user.id, id === auth.user.id ? auth.sessionId : null);
      }
      const updated = (await listUsers(q, auth.sessionId, id))[0];
      if (updated === undefined) throw notFound("That user");
      return { body: updated };
    });
  });

  app.delete("/sessions/:id", { config: { access: CEO_ONLY } }, async (request, reply) => {
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
