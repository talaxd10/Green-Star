// Runs the database tests against a fresh test database.
// Uses TEST_DATABASE_URL and TEST_APP_DATABASE_URL when they are set, so the
// development database is never wiped by a test run.

import { spawnSync } from "node:child_process";
import { requireEnv } from "../src/psql.ts";
import { reset } from "./reset.ts";

const ownerUrl = process.env.TEST_DATABASE_URL ?? requireEnv("DATABASE_URL");
const appUrl = process.env.TEST_APP_DATABASE_URL ?? requireEnv("APP_DATABASE_URL");

console.log(reset(ownerUrl, appUrl));

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "test/*.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: ownerUrl, APP_DATABASE_URL: appUrl },
});
process.exit(result.status ?? 1);
