// Passwords are stored as salted scrypt hashes, never as themselves:
//
//   scrypt$32768$8$3$<salt>$<hash>
//
// The cost is written into each hash, so it can be raised later without
// breaking the passwords already set.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptCost } from "../config.ts";

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function derive(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      // The same characters typed on any keyboard give the same password.
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { N: cost.N, r: cost.r, p: cost.p, maxmem: 256 * cost.N * cost.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string, cost: ScryptCost): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, cost);
  return ["scrypt", cost.N, cost.r, cost.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** True when the password is the one this hash was made from. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parts = hash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const cost = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
  if (![cost.N, cost.r, cost.p].every((n) => Number.isInteger(n) && n > 0) || cost.N > 2 ** 20) return false;
  const salt = Buffer.from(parts[4] as string, "base64url");
  const expected = Buffer.from(parts[5] as string, "base64url");
  const actual = await derive(password, salt, cost);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
