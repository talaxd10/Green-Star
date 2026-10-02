// A thin wrapper over the psql command line client.
//
// Used by the migration runner and the tests. The running application will
// talk to Postgres through a driver; this exists so the ledger can be built
// and proven with nothing installed but Postgres itself.

import { spawnSync } from "node:child_process";

export class PsqlError extends Error {
  readonly stderr: string;
  constructor(stderr: string) {
    super(stderr.trim().split("\n")[0] ?? "psql failed");
    this.name = "PsqlError";
    this.stderr = stderr;
  }
}

/** Runs SQL and returns stdout, unaligned and tuples only. Throws on any SQL error. */
export function psql(url: string, sql: string, options: { singleTransaction?: boolean } = {}): string {
  const args = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"];
  if (options.singleTransaction) args.push("-1");
  args.push(url);
  const result = spawnSync("psql", args, { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new PsqlError(result.stderr);
  return result.stdout.trim();
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example and export its values.`);
  }
  return value;
}

/** A SQL string literal. Only for values this code controls: tests and scripts. */
export function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
