// Wrong passwords are counted and slowed down.
//
// Counted over the last 15 minutes:
//   - 5 wrong tries for one account from one address: that pair waits.
//     A right password clears this count.
//   - 20 wrong tries for one account from anywhere: the account waits.
//   - 30 wrong tries from one address, whatever the account: the address waits.
//
// The first rule keeps someone guessing from another place from locking the
// CEO out of his own office; the second and third stop guessing spread over
// many addresses or many accounts.

import type { Queryable } from "../db.ts";

export const WINDOW_MINUTES = 15;
export const MAX_PER_ACCOUNT_AND_ADDRESS = 5;
export const MAX_PER_ACCOUNT = 20;
export const MAX_PER_ADDRESS = 30;

/** One sign-in at a time per account, so tries sent at the same moment are still counted one by one. */
export async function lockSignIn(q: Queryable, key: string): Promise<void> {
  await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`gs_sign_in:${key}`]);
}

/** Seconds to wait before this account can be tried from this address, or null when it can be tried now. */
export async function secondsToWait(q: Queryable, key: string, ip: string | null): Promise<number | null> {
  const row = await q.first<{ wait: number | null }>(
    `with recent as (
       select sign_in_key, ip, succeeded, at
       from sign_in_attempts
       where at > now() - make_interval(mins => $3) and (sign_in_key = $1 or ip = $2::inet)
     ),
     pair as (
       select at from recent
       where sign_in_key = $1 and ip is not distinct from $2::inet and not succeeded
         and at > coalesce((select max(at) from recent
                            where sign_in_key = $1 and ip is not distinct from $2::inet and succeeded), '-infinity')
     ),
     account as (select at from recent where sign_in_key = $1 and not succeeded),
     address as (select at from recent where ip = $2::inet and not succeeded),
     blocked_until as (
       select (select at from pair order by at desc offset $4 - 1 limit 1) as at
       union all select (select at from account order by at desc offset $5 - 1 limit 1)
       union all select (select at from address order by at desc offset $6 - 1 limit 1)
     )
     select ceil(extract(epoch from max(at) + make_interval(mins => $3) - now()))::int as wait from blocked_until`,
    [key, ip, WINDOW_MINUTES, MAX_PER_ACCOUNT_AND_ADDRESS, MAX_PER_ACCOUNT, MAX_PER_ADDRESS],
  );
  const wait = row?.wait ?? null;
  return wait !== null && wait > 0 ? wait : null;
}

export async function recordAttempt(q: Queryable, key: string, ip: string | null, succeeded: boolean): Promise<void> {
  await q.query("insert into sign_in_attempts (sign_in_key, ip, succeeded) values ($1, $2, $3)", [key, ip, succeeded]);
}
