# Green Star

Delivery and payment system for Green Star (San Cargo). One office web app, one API, one worker, one Postgres ledger. The full plan is the Green Star architecture board, version 3.

## What is built

Tested on Postgres 16. `pnpm test` runs every test: the pure rules in `packages/domain` and the database's guarantees in `packages/db`, against a real Postgres.

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

**Rounds** (build order step 5)

- `packages/db/migrations/0003_rounds.sql`: drivers, carriers, rounds, stops, results, attachments, exceptions, hand-ins and cash counts.
- `packages/domain/src/rounds.ts`: the rules for each outcome and the note counter, so a screen can say what is wrong before anything is sent.

There is no driver app. The CEO builds the round before the driver leaves and enters what happened when he is back.

What the database enforces:

1. A consignment is on one round at a time, and only from a confirmed file. One round can carry goods from several files.
2. Each stop has one result: `paid`, `on_account`, `prepaid`, `held` or `unpaid`. Entering it again replaces it: the old payment is reversed and the new one posted, in one transaction.
3. Goods go on account only for a trusted customer. A pay-first customer who takes goods without paying in full is `unpaid`. After delivery the status follows what is owed, not the word that was picked: a trusted customer who paid part is on account, a pay-first customer who paid part is not paid.
4. Money collected on a round is posted only by entering a result, and moved to the vault only by a hand-in. Neither can be posted or reversed by hand.
5. A payment on a round pays that consignment first. What is left over goes to the customer's oldest unpaid consignment, then stays as credit.
6. A hand-in is counted note by note. A note that does not exist is refused. A gap needs a note, stays on the round, and never reaches the vault.
7. A hand-in needs every stop's result first.
8. The status of a consignment and of a file is worked out from the facts and cannot be typed in. A file closes by itself when every customer on it is paid, prepaid or delivered on account to a trusted customer, the rounds that carried it are handed in, and no dispute is waiting on China. It opens again if the facts change.

Views for the screens and the checks: `round_overview`, `round_stop_details`, `round_cash`, `missed_collections` (the driver forgot to collect), `chase_list` (allowed by the CEO, not yet paid), `held_in_car`, `carton_mismatches`.

**Money** (build order step 6)

- `packages/db/migrations/0004_money.sql`: what each kind of entry may move, the day's rate, the daily vault close, the China account.

What the database enforces:

1. Each kind of entry moves only the accounts it is meant to, in the direction it is meant to (the table `entry_shapes`). A customer's account goes down only against money that really arrived: cash, a wallet or a driver's round. That is what "no discounts or write-offs" means in the ledger.
2. One payment is one customer and one amount in one currency.
3. The day's rate is set through `gs_set_rate`, which logs every change. A rate more than 20% from the last one has to be sent again to confirm: 1,450 typed instead of 145,000 is caught.
4. The vault is closed by counting it note by note. A gap needs a note. Expected cash is the last count plus everything entered since.
5. A count is never edited. A wrong one is taken back and counted again.

Views: `payments` (every payment with how it was paid, read from the ledger), `payments_at_old_rate`, `vault_status`, `vault_close_details`, `china_account`, `china_account_by_day`, `china_account_summary`, `cash_outs`.

`select * from gs_ledger_health();` returns one row per problem. Empty means the books, the allocations, the rounds and every status are sound.

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

The application never inserts lines by hand. Office money goes through two functions:

```sql
select gs_post_entry(kind, happened_at, created_by, idempotency_key, lines, reason, rate, reverses_id, for_consignment);
select gs_reverse_entry(entry_id, created_by, reason, idempotency_key);
```

`packages/domain` builds the lines for each event (`officePayment`, `walletPayment`, `sentToChina`, `cashOut`, `currencyExchange`, `currencyExchangeToDinars`).

Charges come only from files:

```sql
select gs_confirm_shipment(shipment_id, user_id, happened_at);       -- one charge per customer
select gs_cancel_consignment(consignment_id, user_id, reason);        -- reverses its charge
select gs_correct_consignment(consignment_id, amount, other, user_id, reason);
select gs_set_customer_trust(customer_id, trust, limit, user_id, asked_by, note);
```

Round money comes only from rounds:

```sql
insert into rounds (id, driver_id, created_by) values (...);          -- or carrier_id
select gs_add_round_stop(round_id, consignment_id, user_id, cartons_counted);
select gs_remove_round_stop(round_id, consignment_id, user_id);
select gs_round_depart(round_id, user_id, at);
select gs_enter_round_result(result_id, round_id, consignment_id, outcome, user_id, happened_at,
                             received_amount, received_currency, method, note);
select gs_void_round_result(result_id, user_id, reason);
select gs_hand_in_round(hand_in_id, round_id, user_id, happened_at, usd_notes, iqd_notes, note);
select gs_void_hand_in(hand_in_id, user_id, reason);
insert into exceptions (consignment_id, approved_by, reason) values (...);
```

The rate and the vault:

```sql
select gs_set_rate(day, iqd_per_100_usd, user_id, confirm_jump);
select gs_close_vault(close_id, user_id, closed_at, usd_notes, iqd_notes, note);
select gs_void_vault_close(close_id, user_id, reason);
```

A count is an object of note value to how many, in the ledger's unit: `{"10000": 3, "5000": 1}` is three $100 notes and one $50; `{"25000": 4}` is four 25,000 dinar notes. The notes in use are in `cash_denominations`.

Result, hand-in and close ids are sent by the caller. The same id twice is one result, one hand-in, one close, so a double click or a retry is safe.

Sign convention: a positive line is "goes up" for money held or owed to us. Money owed to the China office is a negative balance.

**For the API.** Every function that touches a customer locks that customer first, before it writes anything, takes several customers in id order, and writes an entry's lines in account order. That removes the usual ways two requests end up waiting on each other. It is not a proof: if Postgres reports a deadlock (`40P01`), nothing was written, and the same request can be sent again with the same id.

## Where this differs from the board, and why

- **The rate is stored per 100 dollars, not per dollar.** `145000` is 1,450 per dollar. A market quote such as 152,750 per $100 is 1,527.5 per dollar, which a per-dollar whole number can't hold.
- **Node 22, not Node 20.** Node 20 is past end of life.
- **Tests use Node's built-in runner and the `psql` command, not Vitest and Drizzle yet.** The SQL is the source of truth either way. Both come in with the API, and the `psql` requirement goes away then.
- **One ledger entry per customer charge**, not one per file, so a single charge can be reversed.
- **A consignment can be `cancelled`.** The board has no such status. It is how a wrong amount or a wrong customer is fixed after a file is confirmed.
- **Weight is stored in grams**, as a whole number, for the same reason money is stored in cents.
- **`payment_details` is a view called `payments`, not a table.** The method, the amount as received and the rate are already in the ledger entry. Reading them from there means they can't disagree with it.
- **A payment on a round pays its own consignment first.** The board says payments go to the oldest unpaid. That stays true at the office. At the door it would mark today's goods as unpaid whenever the customer has an older file still in the car, and raise a false "forgot to collect".
- **Statuses are never stored by hand.** The board lists them as fields; here they are worked out from stops, results, payments and hand-ins, and the health check compares the two.
- **A consignment is `closed` when it is delivered, paid in full and its round's cash is counted in.** The board doesn't say when. This makes `reconciling` mean something: the goods are out, the money is not in the vault yet.
- **A vault gap is not posted to the ledger.** The board has no account for it. The gap is kept on the close with its note, and from then on the vault is expected to hold what was counted. `vault_status` shows the ledger, the noted gaps and the expected cash side by side.
- **A round can be handed in more than once.** The missing part of a short hand-in may arrive the next day, and a transport office sends money in parts.
- **The rate has a guard the board doesn't mention:** a change of more than 20% has to be confirmed.

## Assumed, to confirm with the CEO

- Wallet accounts (FIB, FastPay, ZainCash) exist in both dollars and dinars, because the board doesn't say which currency wallet payments arrive in.
- Money sent to China leaves the dollar vault.
- The rate that applies is the rate of the day the money moved (`happened_at`), not the day it was typed in.
- **Dinar rounding.** A customer who owes $62.00 at 1,470 owes 91,140 IQD and will hand over 91,000 or 91,250. With no write-offs, 91,000 leaves 10 cents owed for ever, the consignment shows in `missed_collections` as 10 cents short, and its file stays in `reconciling`. This needs a rule from him.
- **Overpayment.** Money paid above what a customer owes stays on his account as credit and pays toward his next file by itself.
- A phone number with no country code is read as Iraqi (+964).
- A mark prefix matches whole words: `YARO` matches `YARO-OSMAN` and `YARO 2`, but not `YARO2`.
- **The notes he counts.** Dollars: 1, 2, 5, 10, 20, 50, 100. Dinars: 250, 500, 1,000, 5,000, 10,000, 25,000, 50,000. No coins. The list is a table, so it changes without code.
- **A customer can pay by wallet at the door.** That money goes to the wallet's account, not the driver's cash.
- **Goods held in the car take no money on the round.** If he pays later, it is an office or wallet payment, and the goods go out as `paid` on the next round.
- **The vault's first close is its opening count.** Until the starting balances are loaded the ledger starts at zero, so the first count shows the whole box as a gap, with a note. Nothing else is needed to start.
- **The ledger's vault can go below zero.** A cash out typed before the hand-in that funded it is not refused. It shows in `vault_status`.

## Not built yet

Sign-in and roles, the API, the Excel import, the screens, the alerts inbox and the scheduled checks (the views they read are here), the weekly wallet check, statements, starting balances, and the audit log for changes outside the ledger. The columns of `shipment_lines` are provisional until the real China files arrive.
