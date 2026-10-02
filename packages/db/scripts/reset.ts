// Drops and recreates the database named in DATABASE_URL, applies every
// migration, and lets the app login use the app role. For local and test
// databases only: it refuses to touch a database whose name has no "test" or
// "dev" in it unless GS_ALLOW_RESET=1.

import { lit, psql, requireEnv } from "../src/psql.ts";
import { migrate } from "./migrate.ts";

const url = new URL(requireEnv("DATABASE_URL"));
const appUrl = new URL(requireEnv("APP_DATABASE_URL"));
const database = url.pathname.slice(1);

if (!/test|dev/.test(database) && process.env.GS_ALLOW_RESET !== "1") {
  throw new Error(`Refusing to reset "${database}". Reset is for test and dev databases.`);
}
if (!/^[a-z_][a-z0-9_]*$/.test(database)) {
  throw new Error(`Unexpected database name: ${database}`);
}

const admin = new URL(url);
admin.pathname = "/postgres";
psql(admin.toString(), `drop database if exists ${database} with (force);`);
psql(admin.toString(), `create database ${database};`);

const ran = migrate(url.toString());

const appLogin = decodeURIComponent(appUrl.username);
if (!/^[a-z_][a-z0-9_]*$/.test(appLogin)) {
  throw new Error(`Unexpected app login: ${appLogin}`);
}
psql(url.toString(), `grant green_star_app to ${appLogin}; grant connect on database ${database} to ${appLogin};`);

console.log(`Reset ${database}. Applied: ${ran.join(", ")}. App login ${lit(appLogin)} can use the app role.`);
