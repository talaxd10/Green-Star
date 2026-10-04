// Signing in, and the devices signed in.

import { z } from "zod";
import { Uuid } from "./common.ts";

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

const Password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

/**
 * POST /v1/auth/login. The phone number in any spelling
 * ("0770 123 4567" or "+964 770 123 4567").
 */
export const SignInRequest = z.strictObject({
  phone: z.string().trim().min(1, "Enter your phone number").max(64),
  password: z.string().min(1, "Enter your password").max(PASSWORD_MAX_LENGTH),
});
export type SignInRequest = z.infer<typeof SignInRequest>;

export const User = z.object({
  id: Uuid,
  name: z.string(),
  /** +9647701234567 */
  phone: z.string(),
  active: z.boolean(),
});
export type User = z.infer<typeof User>;

/** GET /v1/me, and what signing in returns: who I am. */
export const Me = z.object({
  user: User,
  session: z.object({ id: Uuid, expiresAt: z.iso.datetime() }),
});
export type Me = z.infer<typeof Me>;

/** POST /v1/auth/password. Changing it signs out every other device. */
export const ChangePasswordRequest = z.strictObject({
  current: z.string().min(1, "Enter your current password").max(PASSWORD_MAX_LENGTH),
  next: Password,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export const Session = z.object({
  id: Uuid,
  /** The browser, as it named itself. */
  device: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** True for the session that made this request. */
  current: z.boolean(),
});
export type Session = z.infer<typeof Session>;

/** One row of GET /v1/users: the account and the devices signed in to it. */
export const UserWithSessions = User.extend({
  createdAt: z.iso.datetime(),
  hasPassword: z.boolean(),
  sessions: z.array(Session),
});
export type UserWithSessions = z.infer<typeof UserWithSessions>;

export const UserList = z.object({ users: z.array(UserWithSessions) });
export type UserList = z.infer<typeof UserList>;
