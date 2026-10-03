// Starts the worker. `pnpm --filter @green-star/worker start`
//
// It signs in to the database as the application, with nobody acting: it can
// run the checks and nothing else.

import { requireEnv } from "@green-star/db";
import pg from "pg";
import { scheduleFromEnv, startWorker } from "./checks.ts";

const schedule = scheduleFromEnv();
const pool = new pg.Pool({ connectionString: requireEnv("APP_DATABASE_URL"), max: 2 });
// A connection dropped while idle is replaced by the pool. Without a listener it would take the process down.
pool.on("error", () => {});

console.log(JSON.stringify({ at: new Date().toISOString(), msg: "worker started", ...schedule }));
const worker = startWorker(pool, schedule);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => worker.stop());
}

await worker.done;
await pool.end();
