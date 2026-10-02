# Green Star

Delivery and payment system for Green Star (San Cargo). One office web app, one API, one worker, one Postgres ledger. The full plan is the Green Star architecture board, version 3.

## What is built

**Ledger core** (build order step 2), tested on Postgres 16.

- `packages/db/migrations/0001_ledger_core.sql`: accounts, journal entries and lines, daily dinar rates, cached balances, and the guards.
- `packages/domain`: money as whole numbers, dinar conversion, the Baghdad day, oldest-first allocation, and the lines each money event posts.

What the database enforces, whatever the application does:

1. Every entry sums to zero in each currency.
2. Entries and lines are never updated or deleted, by any role.
3. A line's currency matches its account's currency.
4. Lines can only be written while their entry is being posted.
5. A reversal is the exact mirror of the entry it reverses, once only.
6. An idempotency key posts once, even when the same request arrives eight times at once.
7. A customer payment in dinars converts at that Baghdad day's rate, to the cent.

There is no discount or write-off entry kind and no account for one.

## Run it

Needs Node 22.18 or newer and Postgres 16 (`docker compose -f infra/compose.yaml up -d` starts one with the local roles).

```sh
cp .env.example .env && export $(cat .env | grep -v '^#' | xargs)
pnpm install
pnpm test
```

`pnpm test` resets the test database, applies the migrations and runs every test. To reset a database it must have `test` or `dev` in its name.

## Posting to the ledger

The application never inserts lines by hand. It calls two functions:

```sql
select gs_post_entry(kind, happened_at, created_by, idempotency_key, lines, reason, rate, reverses_id);
select gs_reverse_entry(entry_id, created_by, reason, idempotency_key);
```

`packages/domain` builds the lines for each event (`fileConfirmed`, `driverCollected`, `roundHandedIn`, `officePayment`, `walletPayment`, `sentToChina`, `cashOut`, `currencyExchange`).

Sign convention: a positive line is "goes up" for money held or owed to us. Money owed to the China office is a negative balance.

## Where this differs from the board, and why

- **The rate is stored per 100 dollars, not per dollar.** `145000` is 1,450 per dollar. A market quote such as 152,750 per $100 is 1,527.5 per dollar, which a per-dollar whole number can't hold.
- **Node 22, not Node 20.** Node 20 is past end of life.
- **Tests use Node's built-in runner and `psql`, not Vitest and Drizzle yet.** The package registry was unreachable when this was built. The SQL is the source of truth either way; Drizzle and Vitest come in with the API.
- **One ledger entry per customer charge**, not one per file, so a single charge can be reversed.

## Assumed, to confirm with the CEO

- Wallet accounts (FIB, FastPay, ZainCash) exist in both dollars and dinars, because the board doesn't say which currency wallet payments arrive in.
- Money sent to China leaves the dollar vault.
- The rate that applies is the rate of the day the money moved (`happened_at`), not the day it was typed in.
- **Dinar rounding.** A customer who owes $62.00 at 1,470 owes 91,140 IQD and will hand over 91,000 or 91,250. With no write-offs, 91,000 leaves 10 cents owed for ever. This needs a rule from him.

## Not built yet

Sign-in and roles, customers and files, the Excel import, rounds, the money screens, checks and alerts, statements. The allocations table arrives with consignments; the allocation rule itself is in `packages/domain`.
