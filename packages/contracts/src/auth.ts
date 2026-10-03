// Signing in, and the accounts the CEO adds.

import { z } from "zod";
import { ACTIONS, ROLES } from "./access.ts";
import { Name, Uuid } from "./common.ts";

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

const Password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

/**
 * POST /v1/auth/login. A person types his phone number in any spelling
 * ("0770 123 4567" or "+964 770 123 4567"). The office monitor types its name.
 */
export const SignInRequest = z.strictObject({
  phone: z.string().trim().min(1, "Enter your phone number").max(64),
  password: z.string().min(1, "Enter your password").max(PASSWORD_MAX_LENGTH),
});
export type SignInRequest = z.infer<typeof SignInRequest>;

export const User = z.object({
  id: Uuid,
  name: z.string(),
  role: z.enum(ROLES),
  /** +9647701234567. Null for the office monitor. */
  phone: z.string().nullable(),
  /** What the office monitor signs in with. Null for a person. */
  signInName: z.string().nullable(),
  active: z.boolean(),
});
export type User = z.infer<typeof User>;

/** GET /v1/me, and what signing in returns: who I am and what I can do. */
export const Me = z.object({
  user: User,
  can: z.array(z.enum(ACTIONS)),
  session: z.object({ id: Uuid, expiresAt: z.iso.datetime() }),
});
export type Me = z.infer<typeof Me>;

/** POST /v1/auth/password. Changing it signs out every other device. */
export const ChangePasswordRequest = z.strictObject({
  current: z.string().min(1, "Enter your current password").max(PASSWORD_MAX_LENGTH),
  next: Password,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/** POST /v1/users. The CEO adds the owner or a monitor account. */
export const NewUserRequest = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.literal("owner"),
    name: Name,
    phone: z.string().trim().min(1, "Enter a phone number").max(64),
    password: Password,
  }),
  z.strictObject({
    role: z.literal("monitor"),
    name: Name,
    signInName: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z][a-z0-9_-]{2,31}$/, "3 to 32 letters or digits, starting with a letter, no spaces"),
    password: Password,
  }),
]);
export type NewUserRequest = z.infer<typeof NewUserRequest>;

/** PATCH /v1/users/:id. Switching a user off, or setting his password, signs him out everywhere. */
export const UpdateUserRequest = z
  .strictObject({
    name: Name.optional(),
    active: z.boolean().optional(),
    password: Password.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to change");
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

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
