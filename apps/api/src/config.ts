// Everything the API reads from its environment, in one place.

export interface ScryptCost {
  /** CPU and memory cost. A power of two. */
  N: number;
  r: number;
  p: number;
}

export interface Config {
  /** The application's own database login. It can add to the ledger and never change it. */
  databaseUrl: string;
  host: string;
  port: number;
  /** The addresses the office app is served from. A browser on any other site is refused. */
  webOrigins: readonly string[];
  /** Send the session cookie over HTTPS only. Off only on a developer's own machine. */
  cookieSecure: boolean;
  /** True when the API sits behind the host's proxy, so the caller's address is read from it. */
  trustProxy: boolean;
  scrypt: ScryptCost;
  log: boolean;
}

/** What a password costs to check: about a tenth of a second and 32 MB. */
export const SCRYPT_COST: ScryptCost = { N: 32768, r: 8, p: 3 };

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.`);
  return value;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a port number, got ${env.PORT}`);
  }
  const webOrigins = (env.WEB_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return {
    databaseUrl: required(env, "APP_DATABASE_URL"),
    host: env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1"),
    port,
    webOrigins,
    cookieSecure: flag(env.COOKIE_SECURE, production),
    trustProxy: flag(env.TRUST_PROXY, false),
    scrypt: SCRYPT_COST,
    log: flag(env.LOG, true),
  };
}
