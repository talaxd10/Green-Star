// Runs the API's tests against its own fresh database, green_star_api_test,
// so they never touch the development database or the database package's tests.

import { spawnSync } from "node:child_process";
import { requireEnv } from "@green-star/db";
import { reset } from "@green-star/db/reset";

const DATABASE = "green_star_api_test";

function onTestDatabase(url: string): string {
  const out = new URL(url);
  out.pathname = `/${DATABASE}`;
  return out.toString();
}

const ownerUrl = onTestDatabase(process.env.TEST_DATABASE_URL ?? requireEnv("DATABASE_URL"));
const appUrl = onTestDatabase(process.env.TEST_APP_DATABASE_URL ?? requireEnv("APP_DATABASE_URL"));

console.log(reset(ownerUrl, appUrl));

// `pnpm test` runs every file. `pnpm test test/auth.test.ts` runs one.
const files = process.argv.slice(2).filter((arg) => arg !== "--");
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...(files.length > 0 ? files : ["test/*.test.ts"])], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: ownerUrl, APP_DATABASE_URL: appUrl },
});
process.exit(result.status ?? 1);
