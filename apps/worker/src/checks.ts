// The checks, run on a timer.
//
// What is wrong is worked out by the database (gs_sync_alerts). The API asks
// for it after every save, which covers everything that follows from a save:
// a missed collection, a cash gap, a customer over his limit. Some alerts
// follow from the clock alone: goods held in the car one day too long, a
// vault not counted by closing time, a wallet nobody has checked this week.
// Nobody saves anything when those become true, so the worker asks.
//
// Every so often it asks for the deep run as well, which reads every line in
// the books and raises an alert if the ledger's own health check finds
// anything.

import type pg from "pg";

export interface Schedule {
  /** Seconds between runs. */
  everySeconds: number;
  /** Every how many runs the deep check is included. 1 is every run. */
  deepEvery: number;
}

export const DEFAULT_SCHEDULE: Schedule = { everySeconds: 60, deepEvery: 15 };

export function scheduleFromEnv(env: NodeJS.ProcessEnv = process.env): Schedule {
  const whole = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be a whole number from ${min} to ${max}, got ${raw}`);
    }
    return value;
  };
  return {
    everySeconds: whole("CHECK_EVERY_SECONDS", DEFAULT_SCHEDULE.everySeconds, 5, 3600),
    deepEvery: whole("DEEP_CHECK_EVERY_RUNS", DEFAULT_SCHEDULE.deepEvery, 1, 10_000),
  };
}

/** True when run number `run` (the first is 1) includes the deep check. The first run always does. */
export function isDeepRun(run: number, schedule: Schedule): boolean {
  return (run - 1) % schedule.deepEvery === 0;
}

export interface RunResult {
  deep: boolean;
  /** How many alerts this run opened. */
  opened: number;
  ms: number;
}

/** One run of the checks. */
export async function runChecks(pool: pg.Pool, deep: boolean): Promise<RunResult> {
  const started = Date.now();
  const { rows } = await pool.query<{ opened: number }>("select gs_sync_alerts($1) as opened", [deep]);
  return { deep, opened: Number(rows[0]?.opened ?? 0), ms: Date.now() - started };
}

export interface Worker {
  /** Resolves when the loop has stopped. */
  done: Promise<void>;
  stop(): void;
}

/**
 * Runs the checks now and then every `everySeconds`. A run that fails is
 * logged and the next one still happens: the database being down for a
 * minute must not end the worker.
 */
export function startWorker(
  pool: pg.Pool,
  schedule: Schedule,
  log: (line: Record<string, unknown>) => void = (line) => console.log(JSON.stringify(line)),
): Worker {
  let stopped = false;
  let wake: (() => void) | null = null;

  const done = (async () => {
    for (let run = 1; !stopped; run += 1) {
      const deep = isDeepRun(run, schedule);
      try {
        const result = await runChecks(pool, deep);
        log({ at: new Date().toISOString(), msg: "checks", ...result });
      } catch (error) {
        log({ at: new Date().toISOString(), msg: "checks failed", deep, error: error instanceof Error ? error.message : String(error) });
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, schedule.everySeconds * 1000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  })();

  return {
    done,
    stop() {
      stopped = true;
      wake?.();
    },
  };
}
