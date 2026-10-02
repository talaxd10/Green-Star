# Green Star

Delivery and payment system for Green Star (San Cargo). One office web app, one API, one worker, one Postgres ledger. The full plan is the Green Star architecture board, version 3.

## What is built

Tested on Postgres 16. `pnpm test` runs 68 tests.

**Ledger core** (build order step 2)

- `packages/db/migrations/0001_ledger_core.sql`: accounts, journal entries and lines, daily dinar rates, cached balances, and the guards.
- `packages/domain`: money as whole numbers, dinar conversion, the Baghdad day, and the lines each money event posts.

What the database enforces, whatever the application does:

1. Every entry sums to zero in each currency.
2. Entries and lines are never updated or deleted, by any role.
3. A line's currency matches its account's currency.
4. Lines can only be written while their entry is being posted.
5. A reversal is the exact mirror of the entry it reverses, once only.
6. An idempotency key posts once, even when the same request arrives eight times at once.
7. A customer payment in dinars converts at that Baghdad day's rate, to the cent.

There is no discount or write-off entry kind and no account for one.

**Customers and files** (build order step 3)

- `packages/db/migrations/0002_customers_files.sql`: customers, phones, marks, aliases, source files, shipments, rows, consignments, disputes and allocations.
- `packages/domain`: phone and mark normalising, and the rule for what a customer owes on a file.

What the database enforces:

1. A phone number or a shipping mark belongs to one customer.
2. A file row is matched by phone, then exact mark, then the longest mark prefix (`YARO` matches `YARO MHAMAD`, not `YAROSLAV`).
3. The same file, by its sha256, is never imported twice.
4. Confirming a file posts one charge per customer, once. A prepaid consignment ($0) posts nothing.
5. A confirmed consignment's amount and customer cannot change. A wrong amount is fixed with `gs_correct_consignment`, which reverses the charge and posts a corrected one.
6. Every charge in the ledger belongs to a consignment.
7. Payments pay a customer's oldest unpaid consignments first. This runs by itself whenever anything posts to the customer's account, so it cannot go stale.
8. Trust and credit limits change only through `gs_set_customer_trust`, which records who changed it and who asked.

`select * from gs_ledger_health();` returns one row per problem. Empty means the books and the allocations are sound.

## Run it

Needs Node 22.18 or newer, pnpm, and Postgres 16 with the `psql` command on your PATH.

```sh
docker compose -f infra/compose.yaml up -d   # Postgres with the local roles
cp .env.example .env
pnpm install
pnpm test          # wipes and rebuilds green_star_test, then runs every test
pnpm db:reset      # wipes and rebuilds green_star_dev
```

Reset only works on a database with `test` or `dev` in its name.

## Posting to the ledger

The application never inserts lines by hand. Money events go through two functions:

```sql
select gs_post_entry(kind, happened_at, created_by, idempotency_key, lines, reason, rate, reverses_id);
select gs_reverse_entry(entry_id, created_by, reason, idempotency_key);
```

Charges are different: they come only from files.

```sql
select gs_confirm_shipment(shipment_id, user_id, happened_at);       -- one charge per customer
select gs_cancel_consignment(consignment_id, user_id, reason);        -- reverses its charge
select gs_correct_consignment(consignment_id, amount, other, user_id, reason);
select gs_set_customer_trust(customer_id, trust, limit, user_id, asked_by, note);
```

`packages/domain` builds the lines for each event (`fileConfirmed`, `driverCollected`, `roundHandedIn`, `officePayment`, `walletPayment`, `sentToChina`, `cashOut`, `currencyExchange`).

Sign convention: a positive line is "goes up" for money held or owed to us. Money owed to the China office is a negative balance.

## Where this differs from the board, and why

- **The rate is stored per 100 dollars, not per dollar.** `145000` is 1,450 per dollar. A market quote such as 152,750 per $100 is 1,527.5 per dollar, which a per-dollar whole number can't hold.
- **Node 22, not Node 20.** Node 20 is past end of life.
- **Tests use Node's built-in runner and the `psql` command, not Vitest and Drizzle yet.** The SQL is the source of truth either way. Both come in with the API, and the `psql` requirement goes away then.
- **One ledger entry per customer charge**, not one per file, so a single charge can be reversed.
- **A consignment can be `cancelled`.** The board has no such status. It is how a wrong amount or a wrong customer is fixed after a file is confirmed.
- **Weight is stored in grams**, as a whole number, for the same reason money is stored in cents.

## Assumed, to confirm with the CEO

- Wallet accounts (FIB, FastPay, ZainCash) exist in both dollars and dinars, because the board doesn't say which currency wallet payments arrive in.
- Money sent to China leaves the dollar vault.
- The rate that applies is the rate of the day the money moved (`happened_at`), not the day it was typed in.
- **Dinar rounding.** A customer who owes $62.00 at 1,470 owes 91,140 IQD and will hand over 91,000 or 91,250. With no write-offs, 91,000 leaves 10 cents owed for ever. This needs a rule from him.
- **Overpayment.** Money paid above what a customer owes stays on his account as credit and pays toward his next file by itself.
- A phone number with no country code is read as Iraqi (+964).
- A mark prefix matches whole words: `YARO` matches `YARO-OSMAN` and `YARO 2`, but not `YARO2`.

## Not built yet

Sign-in and roles, the Excel import, rounds, the money screens, checks and alerts, statements, and the audit log for changes outside the ledger. The columns of `shipment_lines` are provisional until the real China files arrive.
