// Starts the API. `pnpm --filter @green-star/api start`

import { buildApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { Db } from "./db.ts";

const config = configFromEnv();
const db = new Db(config.databaseUrl);
const app = await buildApp(config, db);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => db.close());
  });
}

await app.listen({ host: config.host, port: config.port });
