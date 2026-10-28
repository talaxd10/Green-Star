// Where the system is hosted without a server of its own (Vercel): the app's
// database login is worked out from the owner's, so there is one secret to
// set, not two.

import { createHash } from "node:crypto";

/**
 * The owner's connection, straight to the database. Neon's Vercel
 * integration sets DATABASE_URL to its pooler and the direct one as
 * DATABASE_URL_UNPOOLED (or POSTGRES_URL_NON_POOLING); the direct one is
 * used when it is there, because the setup takes a lock that a pooler
 * would not hold.
 */
export function ownerUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of ["DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "DATABASE_URL"]) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** The app login's password: APP_DB_PASSWORD when it is set, otherwise one worked out from the owner's password. */
export function appPassword(ownerUrl: string, explicit?: string | undefined): string {
  if (explicit !== undefined && explicit !== "") return explicit;
  const owner = new URL(ownerUrl);
  return createHash("sha256").update(`green-star app login:${decodeURIComponent(owner.password)}`).digest("base64url");
}

/** The same database and host as the owner's connection, signed in as the app login, gs_app. */
export function appDatabaseUrl(ownerUrl: string, password: string): string {
  const url = new URL(ownerUrl);
  url.username = "gs_app";
  url.password = encodeURIComponent(password);
  return url.href;
}
