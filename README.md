# Green Star

Delivery and payment system for Green Star (San Cargo). One office web app, one API, one worker, one Postgres ledger. The full plan is the Green Star architecture board, version 3.

## What is built

Tested on Postgres 16. `pnpm test` runs every test: the pure rules in `packages/domain`, the database's guarantees in `packages/db`, and the API in `apps/api` over its real routes. All of it runs against a real Postgres. Nothing is mocked.

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

**Sign-in and the API** (build order step 1)

- `packages/db/migrations/0005_users.sql`: users, passwords, sessions, sign-in tries, the audit log, and who may change what.
- `packages/contracts`: the shapes the API takes and returns, shared with the office app.
- `apps/api`: the API. Fastify, REST with JSON under `/v1`.

Three accounts, as the CEO asked: he does everything, the owner sees everything and changes nothing, and the office monitor is a screen.

What the database enforces, whatever the API does:

1. Every "who did it" in the system is a real user.
2. The API tells the database who is acting in each transaction. A change that carries no name is refused.
3. A ledger entry is posted by an active CEO, and by the one who is signed in. The owner and the monitor can never post money, under their own name or anyone else's.
4. Users are added and changed only by a CEO. A password is set only by a CEO or by the user himself.
5. A user keeps his role and is never deleted, because his name is on what he did. He is switched off instead. There is always one active CEO.
6. Every change to a user is in `audit_log` with before and after. The log is never edited, and a password never reaches it.

What the API enforces:

1. Every address says who may call it. One that forgets stops the API from starting. A test calls every address as every role.
2. A person signs in with his phone, typed any way (`0770 123 4567` or `+964 770 123 4567`). The monitor signs in with a name.
3. A wrong phone and a wrong password get the same answer, and take the same time.
4. Five wrong passwords make that account wait 15 minutes from that address. Someone guessing from elsewhere cannot lock the CEO out of his own office.
5. The session is a cookie that scripts on the page cannot read. The database keeps only its sha256, so reading the sessions table signs nobody in.
6. One session per device. Each can be ended on its own. Switching a user off or setting his password signs him out everywhere.
7. Another website cannot use a signed-in browser: the cookie is not sent across sites, and a request that names another site is refused.
8. Everything that only reads runs in a read-only transaction.
9. Every error has the same shape and a code that never changes: `{ "code": "phone_taken", "message": "That phone number already has an account" }`.
10. Logs name the address pattern (`/v1/users/:id`), never the real address, so nothing a person typed reaches them.

**The rest of the API** (customers, files, rounds, money)

- `packages/db/migrations/0006_api.sql`: the CEO-only rule and the audit log on every table outside the ledger, safe retries, merging a duplicate customer, and the lists the screens read.
- `apps/api/src/routes`: one file per part of the business. Each route is a few lines: check the request, call the database's own function or read its view, return the result.

What the database enforces, on top of everything above:

1. Everything outside the ledger is changed only by a CEO too. The owner and the monitor can change nothing, anywhere.
2. Wherever a row says who did something (entered by, counted by, approved by), it names the CEO who is signed in.
3. Every change to customers, files, rounds, drivers and carriers is in `audit_log` with before and after. A status the system works out is not logged as something a person did.
4. A request sent twice with the same key is done once.
5. A duplicate customer is merged into the real one only while it has nothing on the books. After that it is used for nothing.
6. A payment says which consignment it is for only while it is being posted.

What the API enforces:

1. Every write carries an `Idempotency-Key` header: one new value for each click on Save. The key is recorded in the same transaction as the change. The same key again returns the first answer and does nothing. Eight clicks at the same moment post one payment.
2. The rows of a round are saved together or not at all.
3. Money is `{ "amount": 8500, "currency": "USD" }`: a whole number in the smallest unit. A fraction, a zero or an unknown currency is refused before it reaches the database.
4. A time in the future is refused.
5. Lists come a page at a time, newest first. A row added while someone is paging never makes another appear twice or go missing.
6. A search is words, not a pattern: `%` and `_` find only names that contain them.

| | Address | Who | What it does |
|---|---|---|---|
| POST | `/v1/auth/login` | everyone | Sign in with phone and password |
| POST | `/v1/auth/logout` | everyone | End this device's session |
| GET | `/v1/me` | everyone | Who I am and what I can do |
| POST | `/v1/auth/password` | CEO, owner | Change my own password |
| GET | `/v1/users` | CEO | Every account and the devices signed in to it |
| POST | `/v1/users` | CEO | Add the owner or a monitor account |
| PATCH | `/v1/users/:id` | CEO | Rename, switch off or on, set a password |
| DELETE | `/v1/sessions/:id` | CEO | Sign out a device |
| GET | `/v1/customers` | CEO, owner | Search by phone, mark or name; filter trusted, over limit, owing |
| POST | `/v1/customers` | CEO | Create a customer or an agent company |
| GET | `/v1/customers/:id` | CEO, owner | Balance, phones, marks, trust history |
| PATCH | `/v1/customers/:id` | CEO | Name and kind; trust and limit, with who asked |
| POST, DELETE | `/v1/customers/:id/phones` | CEO | Add or remove a phone |
| POST, DELETE | `/v1/customers/:id/marks` | CEO | Add or remove a mark or a mark prefix |
| POST | `/v1/customers/:id/merge` | CEO | Merge a duplicate into this customer |
| GET | `/v1/shipments` | CEO, owner | Files by status |
| POST | `/v1/shipments` | CEO | Type a file in by hand, as a draft |
| GET | `/v1/shipments/:id` | CEO, owner | Consignments, expected vs collected, what blocks closing |
| PUT | `/v1/shipments/:id` | CEO | Replace a draft's rows |
| POST | `/v1/shipments/:id/confirm` | CEO | Post every charge in one transaction |
| GET | `/v1/consignments` | CEO, owner | A customer's consignments, or the goods ready for a round |
| POST | `/v1/consignments/:id/cancel` | CEO | Cancel one and reverse its charge |
| POST | `/v1/consignments/:id/correct` | CEO | Replace one with the right amount |
| GET, POST | `/v1/disputes` | CEO, owner / CEO | Problems with goods; open one and mark it sent to China |
| PATCH | `/v1/disputes/:id` | CEO | Record China's answer and close it |
| GET, POST | `/v1/drivers`, `/v1/carriers` | CEO, owner / CEO | Who carries the goods |
| PATCH | `/v1/drivers/:id`, `/v1/carriers/:id` | CEO | Rename, switch off |
| GET | `/v1/rounds` | CEO, owner | Rounds, newest first |
| POST | `/v1/rounds` | CEO | New round: driver or carrier, consignments from any files, carton counts |
| GET | `/v1/rounds/:id` | CEO, owner | Stops, outcomes, cash, hand-ins |
| POST, DELETE | `/v1/rounds/:id/stops` | CEO | Put a consignment on the round, or take it off |
| POST | `/v1/rounds/:id/depart` | CEO | The driver leaves |
| PUT | `/v1/rounds/:id/results` | CEO | Outcome, amount, currency and method per customer |
| POST | `/v1/round-results/:id/void` | CEO | Take a result back |
| POST | `/v1/rounds/:id/hand-in` | CEO | Cash counted by denomination per currency |
| POST | `/v1/hand-ins/:id/void` | CEO | Take a hand-in back |
| POST | `/v1/exceptions` | CEO | Allow a pay-first handover without full payment, with a reason |
| GET | `/v1/fx-rates/today`, `/v1/fx-rates` | CEO, owner | Today's rate; rates by day |
| PUT | `/v1/fx-rates/:day` | CEO | Set a day's dinar rate (`today` or a date) |
| GET, POST | `/v1/payments` | CEO, owner / CEO | Payments with how each was paid; an office or wallet payment |
| GET, POST | `/v1/cash-outs` | CEO, owner / CEO | Cash out of the vault: China, driver pay, fuel and car, customs and airport, rent and salaries, other |
| POST | `/v1/exchanges` | CEO | Dinars changed into dollars, or back |
| GET | `/v1/vault` | CEO, owner | What should be in the box, the notes, the last closes |
| POST | `/v1/vault/close` | CEO | Daily count by denomination per currency |
| POST | `/v1/vault/closes/:id/void` | CEO | Take a wrong count back |
| POST | `/v1/entries/:id/reverse` | CEO | Reverse a mistake with a reason |
| GET | `/v1/ledger`, `/v1/entries/:id` | CEO, owner | Entries by account and date |
| GET | `/v1/accounts` | CEO, owner | Every account and what is on it |
| GET | `/v1/china-account` | CEO, owner | Owed to China vs sent |
| GET | `/healthz` | everyone | For the host's uptime check |

The shape of every request and reply is in `packages/contracts`.

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

To use the API on your own machine:

```sh
pnpm --filter @green-star/api create-ceo --name "Your name" --phone "0770 123 4567"   # asks for a password
pnpm --filter @green-star/api dev                                                       # http://127.0.0.1:4000
```

`create-ceo` is how the first account is made, and how the CEO gets a new password if he loses his. It runs where the system is hosted, not in the app. Every other account is added by the CEO.

`pnpm --filter @green-star/api test test/auth.test.ts` runs one test file. The same works for `@green-star/db`.

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

**Who is acting.** The API sets `gs.actor` to the signed-in user at the start of every transaction (`Db.write` in `apps/api/src/db.ts`, the only place it happens). The user id passed to a function must be that same user. By hand, as the app's login: `set gs.actor = '<user id>';` first.

**For the API.** Every function that touches a customer locks that customer first, before it writes anything, takes several customers in id order, and writes an entry's lines in account order. That removes the usual ways two requests end up waiting on each other. It is not a proof: if Postgres reports a deadlock (`40P01`), nothing was written, and the same request can be sent again with the same id. `Db.write` does that by itself, up to three times.

## Where this differs from the board, and why

- **The rate is stored per 100 dollars, not per dollar.** `145000` is 1,450 per dollar. A market quote such as 152,750 per $100 is 1,527.5 per dollar, which a per-dollar whole number can't hold.
- **Node 22, not Node 20.** Node 20 is past end of life.
- **No ORM. The API talks to Postgres with plain SQL (`pg`), not Drizzle.** The rules live in the database as functions and views, so the API mostly calls a function or reads a view. A second description of 30 tables in TypeScript would be one more thing to keep in step.
- **Tests use Node's built-in runner, not Vitest.** It does the job and is one less thing to install. The migration runner and the tests still need the `psql` command; the running API does not.
- **Sign-in is built here, not with Better Auth.** Better Auth wants an email for every user and brings its own tables and ids. This system has three accounts, signs in with a phone number, and already keeps its rules in Postgres. What is built is small and each part is tested: scrypt hashes (Node's own), random session tokens stored as sha256, and the limits above.
- **The office monitor signs in with a name, not a phone.** It is a screen, not a person, and has no number of its own.
- **A file can be typed in by hand** (`POST /v1/shipments`). The board only has the Excel import, which waits on the real China files. Typing a file in is what makes the rest usable before then, and stays useful for a file the import cannot read.
- **A payment at the office can name the consignment it is for** (`forConsignmentId`). Left out, it pays the oldest first, as the board says. It is there for the customer who comes in to pay for goods held in the car while an older file is still on his account.
- **Merging a duplicate customer does not move money.** It works while the duplicate has nothing on the books. One that already has a charge or a payment is fixed the way every money mistake is: reversed and entered again under the right customer.
- **Extra addresses the board does not list**, because the screens need them: phones, drivers, carriers, stops, taking a result, a hand-in or a vault close back, cancelling and correcting a consignment, and the read side of payments, cash outs, the vault and the accounts.
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

- **A password is at least 10 characters.** No other rules.
- **A session ends after 14 days without use** for the CEO and the owner, and after 400 days for the office monitor, because nobody is at the screen to sign in again.
- **Wrong passwords.** 5 for one account from one address, 20 for one account from anywhere, or 30 from one address: wait 15 minutes.
- **There is one way to add a CEO**, the `create-ceo` command. The app adds only the owner and monitor accounts.

## Not built yet

The Excel import (`/v1/imports`, waiting on the real China files), receipts and photos (`/v1/attachments`, which needs the file storage set up), the screens, the alerts inbox and the scheduled checks (the views they read are here), the weekly wallet check, statements, the office monitor, settings, and starting balances. The columns of `shipment_lines` are provisional until the real China files arrive.
