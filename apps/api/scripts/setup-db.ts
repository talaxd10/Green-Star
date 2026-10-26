// Sets the database up where there is no psql and no server of our own: on
// Vercel it runs as part of every build, before the office app is built.
//
//   node apps/api/scripts/setup-db.ts
//
// 1. Applies every migration not applied yet, each in its own transaction,
//    as the owner login (DATABASE_URL; on Neon, the string with pooling off).
// 2. Makes sure the app's own login, gs_app, exists with the right password
//    and the green_star_app rights. The running app signs in as gs_app and
//    can never change the ledger.
// 3. On an empty database, makes the CEO's account from CEO_NAME, CEO_PHONE
//    and CEO_PASSWORD. Once there is an account they are not read again.
//
// Without DATABASE_URL it does nothing, so a build that has no database
// (a preview, say) still builds.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { appPassword } from "../src/hosting.ts";

const owner = process.env.DATABASE_URL;
if (owner === undefined || owner === "") {
  console.log("No DATABASE_URL: the database was not set up.");
  process.exit(0);
}

const client = new pg.Client({ connectionString: owner });
await client.connect();
try {
  // Two builds at once take turns.
  await client.query("select pg_advisory_lock(hashtextextended('green-star setup', 0))");

  await client.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
  const applied = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((row) => row.name));
  const dir = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
  const ran: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    ran.push(file);
  }
  console.log(ran.length === 0 ? "Database is up to date." : `Applied: ${ran.join(", ")}`);

  const password = appPassword(owner, process.env.APP_DB_PASSWORD);
  const role = await client.query("select 1 from pg_roles where rolname = 'gs_app'");
  const make = role.rowCount === 0 ? "create role gs_app login password %L" : "alter role gs_app login password %L";
  const statement = await client.query<{ sql: string }>("select format($1, $2::text) as sql", [make, password]);
  await client.query((statement.rows[0] as { sql: string }).sql);
  await client.query("grant green_star_app to gs_app");
  const database = await client.query<{ sql: string }>("select format('grant connect on database %I to gs_app', current_database()) as sql");
  await client.query((database.rows[0] as { sql: string }).sql);
  console.log("The app login is ready.");

  const users = Number((await client.query<{ n: string }>("select count(*) as n from users")).rows[0]?.n ?? 0);
  if (users === 0) {
    const phone = process.env.CEO_PHONE ?? "";
    const secret = process.env.CEO_PASSWORD ?? "";
    if (phone === "" || secret === "") {
      console.log("There is no account yet. Set CEO_PHONE and CEO_PASSWORD, then build again.");
    } else {
      const made = spawnSync(process.execPath, [...process.execArgv, "scripts/create-ceo.ts", "--name", process.env.CEO_NAME || "CEO", "--phone", phone], {
        cwd: join(import.meta.dirname, ".."),
        env: { ...process.env, GS_PASSWORD: secret },
        stdio: "inherit",
      });
      if (made.status !== 0) throw new Error("The CEO's account could not be made.");
    }
  }
} finally {
  await client.end();
}
