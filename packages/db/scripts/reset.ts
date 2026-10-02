// Drops and recreates the database named in DATABASE_URL, applies every
// migration, and lets the app login use the app role. For local and test
// databases only: it refuses to touch a database whose name has no "test" or
// "dev" in it.

import { psql, requireEnv } from "../src/psql.ts";
import { migrate } from "./migrate.ts";

const NAME = /^[a-z_][a-z0-9_]*$/;

export function reset(ownerUrl: string, appUrl: string): string {
  const url = new URL(ownerUrl);
  const database = url.pathname.slice(1);
  if (!NAME.test(database)) {
    throw new Error(`Unexpected database name: ${database}`);
  }
  if (!/test|dev/.test(database)) {
    throw new Error(`Refusing to reset "${database}". Reset is for test and dev databases.`);
  }
  const appLogin = decodeURIComponent(new URL(appUrl).username);
  if (!NAME.test(appLogin)) {
    throw new Error(`Unexpected app login: ${appLogin}`);
  }

  const admin = new URL(url);
  admin.pathname = "/postgres";
  psql(admin.toString(), `drop database if exists ${database} with (force);`);
  psql(admin.toString(), `create database ${database};`);

  const ran = migrate(url.toString());
  psql(url.toString(), `grant green_star_app to ${appLogin}; grant connect on database ${database} to ${appLogin};`);
  return `Reset ${database}. Applied: ${ran.join(", ")}.`;
}

if (import.meta.main) {
  console.log(reset(requireEnv("DATABASE_URL"), requireEnv("APP_DATABASE_URL")));
}
