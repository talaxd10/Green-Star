// Applies every migration in ./migrations that has not been applied yet,
// each inside its own transaction. Run as the owner role, never the app role.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lit, psql, requireEnv } from "../src/psql.ts";

/** `upTo` stops after that file: for the tests that prove a migration on a database that already has data. */
export function migrate(url: string, upTo?: string): string[] {
  psql(
    url,
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     );`,
  );
  const applied = new Set(psql(url, "select name from schema_migrations order by name;").split("\n").filter(Boolean));
  const dir = join(import.meta.dirname, "..", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql") && (upTo === undefined || f <= upTo)).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    psql(url, `${sql}\ninsert into schema_migrations (name) values (${lit(file)});`, { singleTransaction: true });
    ran.push(file);
  }
  return ran;
}

if (import.meta.main) {
  const ran = migrate(requireEnv("DATABASE_URL"));
  console.log(ran.length === 0 ? "Database is up to date." : `Applied: ${ran.join(", ")}`);
}
