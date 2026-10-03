// Runs the office app end to end, the way a person uses it: a real browser,
// the real app, the real API and a real Postgres. Nothing is mocked.
//
//   pnpm --filter @green-star/web e2e
//
// It makes its own database (green_star_e2e_test), builds the app, starts the
// API and the app on spare ports, runs e2e/*.spec.ts in Chromium, and stops
// everything. The first time on a machine: `npx playwright install chromium`.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { requireEnv } from "@green-star/db";
import { reset } from "@green-star/db/reset";

const DATABASE = "green_star_e2e_test";
const API_PORT = 4100;
const WEB_PORT = 3100;
const WEB_URL = `http://localhost:${WEB_PORT}`;
const root = join(import.meta.dirname, "..");
const api = join(root, "..", "api");

function onDatabase(url: string): string {
  const out = new URL(url);
  out.pathname = `/${DATABASE}`;
  return out.toString();
}

const ownerUrl = onDatabase(process.env.TEST_DATABASE_URL ?? requireEnv("DATABASE_URL"));
const appUrl = onDatabase(process.env.TEST_APP_DATABASE_URL ?? requireEnv("APP_DATABASE_URL"));
console.log(reset(ownerUrl, appUrl));

const env = {
  ...process.env,
  DATABASE_URL: ownerUrl,
  APP_DATABASE_URL: appUrl,
  PORT: String(API_PORT),
  HOST: "127.0.0.1",
  WEB_ORIGINS: WEB_URL,
  COOKIE_SECURE: "false",
  LOG: "0",
  API_URL: `http://127.0.0.1:${API_PORT}`,
  NEXT_DIST_DIR: ".next-e2e",
  NEXT_TELEMETRY_DISABLED: "1",
  E2E_URL: WEB_URL,
};

function run(command: string, args: string[], cwd: string, extra: Record<string, string> = {}): void {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extra }, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

// The first CEO, the way whoever sets the system up makes him.
run(process.execPath, ["scripts/create-ceo.ts", "--name", "Sarkar", "--phone", "0770 000 0001"], api, { GS_PASSWORD: "office password 1" });
// Next and Playwright are started as plain node programs, not through npx, so
// that stopping them really stops them and nothing is left holding a port.
const next = join(root, "node_modules", "next", "dist", "bin", "next");
const playwright = join(root, "node_modules", "@playwright", "test", "cli.js");
run(process.execPath, [next, "build"], root);

const children: ChildProcess[] = [];
const start = (args: string[], cwd: string) => {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
  children.push(child);
  return child;
};
const stop = () => {
  for (const child of children) child.kill("SIGTERM");
};
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(1));

async function ready(url: string, what: string): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what} did not start at ${url}`);
}

let status = 1;
try {
  start(["src/main.ts"], api);
  start([next, "start", "--port", String(WEB_PORT)], root);
  await ready(`http://127.0.0.1:${API_PORT}/healthz`, "The API");
  await ready(`${WEB_URL}/sign-in`, "The office app");
  const tests = spawnSync(process.execPath, [playwright, "test", ...process.argv.slice(2).filter((arg) => arg !== "--")], { cwd: root, env, stdio: "inherit" });
  status = tests.status ?? 1;
} finally {
  stop();
}
process.exit(status);
