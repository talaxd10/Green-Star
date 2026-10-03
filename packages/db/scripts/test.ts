// Runs the database tests against a fresh test database.
// Uses TEST_DATABASE_URL and TEST_APP_DATABASE_URL when they are set, so the
// development database is never wiped by a test run.

import { spawnSync } from "node:child_process";
import { lit, psql, requireEnv, withActor } from "../src/psql.ts";
import { reset } from "./reset.ts";

/** The CEO every test acts as. The same id as USER in test/helpers.ts. */
const TEST_CEO = "99999999-9999-4999-8999-999999999999";

const ownerUrl = process.env.TEST_DATABASE_URL ?? requireEnv("DATABASE_URL");
const appUrl = process.env.TEST_APP_DATABASE_URL ?? requireEnv("APP_DATABASE_URL");

console.log(reset(ownerUrl, appUrl));
psql(ownerUrl, `insert into users (id, name, role, phone) values (${lit(TEST_CEO)}, 'Test CEO', 'ceo', '+9647700000000');`);

// `pnpm test` runs every file. `pnpm test test/users.test.ts` runs one.
const files = process.argv.slice(2).filter((arg) => arg !== "--");
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...(files.length > 0 ? files : ["test/*.test.ts"])], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: ownerUrl,
    // Statements sent as the application act as the test CEO unless a test says otherwise.
    APP_DATABASE_URL: withActor(appUrl, TEST_CEO),
    APP_DATABASE_URL_NO_ACTOR: appUrl,
  },
});
process.exit(result.status ?? 1);
