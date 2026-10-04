# Green Star

Delivery and payment system for Green Star (San Cargo). One office web app, one API, one worker, one Postgres ledger. The full plan is the Green Star architecture board, version 3.

## What is built

Tested on Postgres 16. `pnpm test` runs every test: the pure rules in `packages/domain`, the database's guarantees in `packages/db`, the API in `apps/api` over its real routes, the worker in `apps/worker`, and the office app's money arithmetic in `apps/web`. All of it runs against a real Postgres. Nothing is mocked.

**Ledger core** (build order step 2)

- `packages/db/migrations/0001_ledger_core.sql`: accounts, journal entries and lines, daily dinar rates, cached balances, and the guards.
- `packages/domain`: money as whole numbers, dinar conversion, the Baghdad day, and the lines each money event posts.

What the database enforces, whatever the application does:

1. Every entry sums to zero in each currency.
2. Entries and lines are never updated or deleted, by anyone.
3. A line's currency matches its account's currency.
4. Lines can only be written while their entry is being posted.
5. A reversal is the exact mirror of the entry it reverses, once only.
6. An idempotency key posts once, even when the same request arrives eight times at once.
7. A customer payment in dinars converts at that Baghdad day's rate, to the cent.

There is no discount entry kind and no account for one. The one way an amount comes off a customer's account without money arriving is the CEO's Error entry, small and capped (see Dinar rounding and the Error entry below).

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
2. Each stop has one result: `paid`, `on_account`, `prepaid`, `held` or `unpaid`. Entering it again replaces it: the old payments are reversed and the new ones posted, in one transaction.
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

1. Each kind of entry moves only the accounts it is meant to, in the direction it is meant to (the table `entry_shapes`). A customer's account goes down only against money that really arrived (cash, a wallet or a driver's round) or by an Error entry inside its limit. That is what "no discounts" means in the ledger.
2. One payment is one customer and one amount in one currency.
3. The day's rate is set through `gs_set_rate`, which logs every change. A rate more than 20% from the last one has to be sent again to confirm: 1,450 typed instead of 145,000 is caught.
4. The vault is closed by counting it note by note. A gap needs a note. Expected cash is the last count plus everything entered since.
5. A count is never edited. A wrong one is taken back and counted again.

Views: `payments` (every payment with how it was paid, read from the ledger), `payments_at_old_rate`, `vault_status`, `vault_close_details`, `china_account`, `china_account_by_day`, `china_account_summary`, `cash_outs`.

`select * from gs_ledger_health();` returns one row per problem. Empty means the books, the allocations, the rounds and every status are sound.

**Dinar rounding, paying in parts, and the Error entry** (the CEO's rules, October 2026)

- `packages/db/migrations/0011_new_kinds.sql`, `0012_dinar_rounding_and_errors.sql`, `0013_round_payment_parts.sql`, `0014_nearest_amount_settles.sql`.
- `packages/domain/src/fx.ts` (`roundDinars`, `dinarsSettle`, `dinarCredit`) and `payments.ts` (`planPayment`): the same working-out in the screens, the API and the database.

His words: "Sometimes a customer owes $533. $400 he pays with dollars, $133 with dinars: 133 x 1,570 = 208,810. What I do is $400 + 209,000 IQD = $533." "You can just do a normal rounding." "There are customers who pay by all three: dollars, dinars and FIB." "If there becomes a $5 error or something, I will just do a data entry and call it Error."

What the database enforces:

1. Dinars handed over still pass through the books at exactly what they convert to at the day's rate. Nothing about the conversion changed.
2. A dinar payment that comes to what is owed, give or take half the rounding step, settles it exactly. The step is 1,000 dinars (so 500 either way) and is in Settings; 0 switches rounding off. "What is owed" is the consignment the payment is for, or everything the customer owes; when the dinars come to both (the two are less than a step apart), the nearer one. A part payment, an overpayment and a payment in dollars are never rounded.
3. The difference is a line on the `Dinar rounding` account in the same entry, so the books say what rounding gave and took. No entry can carry a rounding line larger than half a step, or one that does not settle what was owed, whatever the application sends.
4. One visit, or one stop on a round, can be paid in up to four parts: dollars and dinars, cash and a wallet. Each part is its own entry, one amount in one currency. Dollars are applied first, then dinars in the order given, so it is the dinars that settle what is left. All parts are saved or none is.
5. On a round the driver's dollars and dinars each go to the round's cash in that currency, and a wallet part goes to the wallet. Taking the result back, or entering the stop again, reverses every part. A part is never edited or deleted, and cannot be reversed by hand from the ledger.
6. An Error entry takes an amount off what one customer owes and puts it on the `Errors` account. It is never more than the limit in Settings ($5; 0 switches it off), never more than he owes, it only ever takes off, and it is for one customer. It pays his oldest unpaid file the way a payment does, shows as its own line on his statement, and is reversed like any other entry.
7. Both settings are in the one settings row: changed only by the CEO, every change in the audit log.

The two accounts (`dinar_rounding_usd`, `errors_usd`) are on `/v1/accounts` with everything else. `dinar_rounding` and `error_entries` are the views behind the screens.

**Sign-in and the API** (build order step 1)

- `packages/db/migrations/0005_users.sql`: users, passwords, sessions, sign-in tries, the audit log, and who may change what.
- `packages/contracts`: the shapes the API takes and returns, shared with the office app.
- `apps/api`: the API. Fastify, REST with JSON under `/v1`.

One kind of account: the CEO's. The system is his alone, so nobody else signs in, there is no read-only account and no office screen (`0010_only_the_ceo.sql`). An owner or monitor account made before that is switched off for good and signed out.

What the database enforces, whatever the API does:

1. Every "who did it" in the system is a real user.
2. The API tells the database who is acting in each transaction. A change that carries no name is refused.
3. A ledger entry is posted by an active CEO, and by the one who is signed in. An account that was switched off can post nothing, under its own name or anyone else's.
4. No account can be made that is not a CEO's, by the application or by the login that owns the database. A password is set only by a CEO or by the user himself.
5. A user is never deleted, because his name is on what he did. He is switched off instead. There is always one active CEO.
6. Every change to a user is in `audit_log` with before and after. The log is never edited, and a password never reaches it.

What the API enforces:

1. Every address says whether it is open before signing in (signing in and out, the uptime check) or needs the CEO signed in. One that forgets stops the API from starting. A test calls every address signed in, signed out, with a made-up session, with one that ran out, and as an account that was switched off.
2. He signs in with his phone, typed any way (`0770 123 4567` or `+964 770 123 4567`), and with nothing else.
3. A wrong phone and a wrong password get the same answer, and take the same time.
4. Five wrong passwords make that account wait 15 minutes from that address. Someone guessing from elsewhere cannot lock the CEO out of his own office.
5. The session is a cookie that scripts on the page cannot read. The database keeps only its sha256, so reading the sessions table signs nobody in.
6. One session per device. Each can be ended on its own. Changing the password signs out every other device.
7. Another website cannot use a signed-in browser: the cookie is not sent across sites, and a request that names another site is refused.
8. Everything that only reads runs in a read-only transaction.
9. Every error has the same shape and a code that never changes: `{ "code": "phone_taken", "message": "That phone number already has an account" }`.
10. Logs name the address pattern (`/v1/customers/:id`), never the real address, so nothing a person typed reaches them.

**The rest of the API** (customers, files, rounds, money)

- `packages/db/migrations/0006_api.sql`: the CEO-only rule and the audit log on every table outside the ledger, safe retries, merging a duplicate customer, and the lists the screens read.
- `apps/api/src/routes`: one file per part of the business. Each route is a few lines: check the request, call the database's own function or read its view, return the result.

What the database enforces, on top of everything above:

1. Everything outside the ledger is changed only by an active CEO too.
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

Signing in, signing out and `/healthz` are open. Every other address needs the CEO signed in.

| | Address | What it does |
|---|---|---|
| POST | `/v1/auth/login` | Sign in with phone and password |
| POST | `/v1/auth/logout` | End this device's session |
| GET | `/v1/me` | Who I am |
| POST | `/v1/auth/password` | Change my password |
| GET | `/v1/users` | The account and the devices signed in to it |
| DELETE | `/v1/sessions/:id` | Sign out a device |
| GET | `/v1/customers` | Search by phone, mark or name; filter trusted, over limit, owing |
| POST | `/v1/customers` | Create a customer or an agent company |
| GET | `/v1/customers/:id` | Balance, phones, marks, trust history |
| PATCH | `/v1/customers/:id` | Name and kind; trust and limit, with who asked |
| POST, DELETE | `/v1/customers/:id/phones` | Add or remove a phone |
| POST, DELETE | `/v1/customers/:id/marks` | Add or remove a mark or a mark prefix |
| POST | `/v1/customers/:id/merge` | Merge a duplicate into this customer |
| GET | `/v1/shipments` | Files by status |
| POST | `/v1/shipments` | Type a file in by hand, as a draft |
| GET | `/v1/shipments/:id` | Consignments, expected vs collected, what blocks closing |
| PUT | `/v1/shipments/:id` | Replace a draft's rows |
| POST | `/v1/shipments/:id/confirm` | Post every charge in one transaction |
| GET | `/v1/consignments` | A customer's consignments, or the goods ready for a round |
| POST | `/v1/consignments/:id/cancel` | Cancel one and reverse its charge |
| POST | `/v1/consignments/:id/correct` | Replace one with the right amount |
| GET, POST | `/v1/disputes` | Problems with goods; open one and mark it sent to China |
| PATCH | `/v1/disputes/:id` | Record China's answer and close it |
| GET, POST | `/v1/drivers`, `/v1/carriers` | Who carries the goods |
| PATCH | `/v1/drivers/:id`, `/v1/carriers/:id` | Rename, switch off |
| GET | `/v1/rounds` | Rounds, newest first |
| POST | `/v1/rounds` | New round: driver or carrier, consignments from any files, carton counts |
| GET | `/v1/rounds/:id` | Stops, outcomes, cash, hand-ins |
| POST, DELETE | `/v1/rounds/:id/stops` | Put a consignment on the round, or take it off |
| POST | `/v1/rounds/:id/depart` | The driver leaves |
| PUT | `/v1/rounds/:id/results` | Outcome, amount, currency and method per customer |
| POST | `/v1/round-results/:id/void` | Take a result back |
| POST | `/v1/rounds/:id/hand-in` | Cash counted by denomination per currency |
| POST | `/v1/hand-ins/:id/void` | Take a hand-in back |
| POST | `/v1/exceptions` | Allow a pay-first handover without full payment, with a reason |
| GET | `/v1/fx-rates/today`, `/v1/fx-rates` | Today's rate; rates by day |
| PUT | `/v1/fx-rates/:day` | Set a day's dinar rate (`today` or a date) |
| GET, POST | `/v1/payments` | Payments with how each was paid; an office or wallet payment |
| POST | `/v1/payments/parts` | One visit paid in two to four ways: dollars and dinars, cash and a wallet. All saved or none |
| GET, POST | `/v1/errors` | The CEO's Error entries; a small amount off what a customer owes |
| GET, POST | `/v1/cash-outs` | Cash out of the vault: China, driver pay, fuel and car, customs and airport, rent and salaries, other |
| POST | `/v1/exchanges` | Dinars changed into dollars, or back |
| GET | `/v1/vault` | What should be in the box, the notes, the last closes |
| POST | `/v1/vault/close` | Daily count by denomination per currency |
| POST | `/v1/vault/closes/:id/void` | Take a wrong count back |
| POST | `/v1/entries/:id/reverse` | Reverse a mistake with a reason |
| GET | `/v1/ledger`, `/v1/entries/:id` | Entries by account and date |
| GET | `/v1/accounts` | Every account and what is on it |
| GET | `/v1/china-account` | Owed to China vs sent |
| GET | `/v1/customers/:id/statement` | Every charge and payment with a running balance. `?from=`, `?corrections=true` |
| POST | `/v1/customers/:id/statement/export` | Make the copy to send: an image, a PDF and a text |
| GET | `/v1/customers/:id/statements` | The copies made for one customer |
| GET | `/v1/statements` | Who to send one to: trusted customers who owe, and when each was last sent one |
| GET | `/v1/statements/:id`, `/image`, `/pdf` | One copy as it was made, and its PNG and PDF |
| POST | `/v1/statements/:id/sent` | He sent it |
| GET | `/v1/alerts` | Open alerts, newest first. `?status=resolved` or `cleared`, `?kind=` |
| GET | `/v1/alerts/count` | How many are open, and how many of those are serious |
| POST | `/v1/alerts/:id/resolve` | Close an alert with a note |
| GET | `/v1/reports/today` | Today's rounds: to collect, collected, counted in, per currency. Files in progress |
| GET | `/v1/wallets` | Each wallet: the books, what its app should show, the last checks |
| POST | `/v1/wallets/checks` | What the wallet's app shows, typed in and compared |
| GET, PUT | `/v1/settings` | Held-in-car days, vault closing time, wallet check days, the dinar rounding step, the Error limit |
| GET | `/healthz` | For the host's uptime check. 503 when the database is down or the checks failed after the latest save |

The shape of every request and reply is in `packages/contracts`.

**Checks and alerts**

- `packages/db/migrations/0008_alerts.sql`: the settings, the wallet check, the alerts, and the one function that works out what is wrong.
- `apps/api/src/routes/alerts.ts`: alerts, the Today report, wallets and settings.
- `apps/worker`: runs the checks on a timer.

How it works. `gs_current_problems()` returns everything that does not match right now, one row per thing. `gs_sync_alerts()` writes that answer down: it opens an alert for each new thing and ends the ones that are no longer true. The API calls it at the end of every save, in the same transaction, so "the driver forgot to collect" is on the screen the moment the round is saved. The worker calls it every minute, for the alerts that follow from the clock and not from a save, and every 15th run also runs the ledger's own health check.

| Alert | Raised when | Goes away by itself when |
|---|---|---|
| Not collected (high) | A pay-first customer has the goods, has not paid in full, and no exception was allowed. His top alert | He pays, or the CEO allows an exception |
| Round cash (high) | A round is handed in and the cash counted differs from its receipts, per currency | The rest is counted in |
| Vault count (high) | A vault count differs from what should be there, per currency | The count is taken back |
| Wallet (high) | A wallet check found the app showing something else than the books | Never. It is resolved with a note |
| The books (high) | The ledger's own health check finds anything at all | The health check is clean again |
| Vault not counted (medium) | Cash moved in or out of the vault and closing time has passed without a count | The vault is counted |
| Cartons (medium) | Cartons counted at the airport differ from the file | A "missing" dispute is opened, or the count is corrected |
| Over limit (medium) | A trusted customer owes more than his own limit | He is back under it |
| Held in the car (medium) | Goods have been held for the set number of days (3) | They go out again |
| Old rate (medium) | A dinar payment was posted before the day's rate was changed | It is reversed |
| Wallet check (low) | Money in a wallet has waited the set number of days (7) without a check | The wallet is checked |

What the database enforces:

1. What is wrong is worked out from the facts every time, never typed in. The application can read alerts and nothing else; they change only through the two functions.
2. One thing that is wrong is one alert, however often the checks run and however many saves end at the same moment.
3. An alert ends in one of two ways: the CEO resolves it with a note, or the facts change and it goes away by itself. Nothing deletes one, and a resolved alert's note is never rewritten, by anyone.
4. A resolved alert stays resolved while the same thing is still wrong. If it stops being wrong and happens again, that is a new alert.
5. The office settings are one row, changed only by the CEO, and every change is in the audit log.
6. A wallet check is never edited. A gap needs a note, and from then on the app is expected to show what it showed: the last reading plus everything entered since, the same rule as the vault.
7. Only the schema owner can run the checks as of another moment. The tests use that to prove the clock rules; the application's checks are always now.

What the API enforces:

1. A save is never lost because a check failed. The checks run inside a savepoint; a failure is undone alone, counted and logged, and `/healthz` answers 503 until the checks next run clean.

**Statements**

- `packages/db/migrations/0009_statements.sql`: a customer's account line by line with the balance after each, the copies made to send, and the list of who to send one to.
- `apps/api/src/statement.ts`: the text and the page, made from the one statement. `apps/api/src/render.ts`: draws the page into a PNG and a PDF with a headless Chromium.
- `apps/api/src/routes/statements.ts`: the addresses.

His second ask: trusted customers are told what they owe. The CEO opens a customer's statement, clicks once, and gets an image, a PDF and a short text to send from his own phone. He marks it as sent, and the Statements screen shows who has not had one this week.

What the database enforces:

1. A statement is read from the ledger and nowhere else: the lines on the customer's account in the order they happened, each with the balance after it. The last line is what he owes.
2. A mistake and its reversal are left off a statement together, never one without the other, so what is left always adds up to the balance. `?corrections=true` shows both.
3. A copy made to send is kept exactly as it was drawn. The customer is locked while it is made, and a copy whose balance is not the ledger's at that moment is refused.
4. A copy is marked as sent once, by the CEO. Nothing else about it changes, by anyone, and it is never deleted.

What the API enforces:

1. The image, the PDF and the text are all made from the copy the database kept, so the three cannot say different amounts. The balance is never taken from the request.
2. A name is drawn as text, never as markup. While the page is drawn, scripts are off and nothing is fetched: its fonts are inside it, including one for Kurdish and Arabic letters.
3. A copy to send shows the latest 40 lines; older ones are summed into one "balance before" line.
4. Without Chromium the text is still made, and the image and PDF addresses answer 503 saying why.

**The office screens**

- `apps/web`: the office app. Next.js, for Chrome or Edge on a Windows desktop. English screens; Kurdish and Arabic names are shown exactly as written.

Built so far: sign-in, Today (alerts, the rate, today's rounds, to collect vs collected vs counted in, files in progress), Alerts (open, resolved, went away), Customers, a customer's page, his statement (the account with a running balance, and the copy to send), Statements (who to send one to this week), Files, typing a file in, a file's page, Rounds, a new round, a round's page (results, the driver's cash, exceptions), Money (today's rate, payments in one or several parts, cash out, exchange, the Error entry, reversing, the wallet check), Vault close, China account, and Settings (the checks, the money rules, drivers, carriers, the password, and the devices signed in).

What the screens enforce:

1. The browser only ever talks to the office app's own address. Requests to `/v1` are passed on to the API, so the session cookie never crosses sites.
2. Each Save button holds the key for its click. If the connection drops and Save is clicked again, the same key goes with it and the work is done once.
3. An amount is typed the way he writes it (`85`, `85.50`, `1,234.56`, `123,250`) and kept as a whole number. `85,5` is refused, not read as 855: a comma is a thousands mark, never a decimal point. Half a dinar is refused.
4. The rate is typed the way the market quotes it, per $100, with the per-dollar rate shown beside it. A rate far from the last one is asked for again before it is taken.
5. A round's rows are checked with the same rules as the database before anything is sent, so the screen says what is wrong on the row itself. A stop takes up to four payments.
6. Cash is counted note by note and shown beside what should be there. A gap cannot be saved without a note.
7. A session that ended while a screen was open sends him back to sign in, and then back to where he was.
8. No screen adds an account or changes one. Settings lists the devices he is signed in on, and signs out one he no longer uses.
9. Before Save, a payment shows what each part will be worth on his account, what is left, and for dinars the amount to ask for: "What is left is 192,850 IQD. Use 193,000." It is worked out by the same function the API posts with.
10. A stop that came up short by no more than the Error limit links straight to the Error entry, with the customer and the amount filled in. Money shows what rounding has given or taken and what was let go as errors, in all.

`pnpm --filter @green-star/web e2e` runs a day at the office in a real browser against the real API and a real Postgres: a wrong password, two customers, a file typed in and confirmed, the rate, a round out and back, the cash counted in, a payment at the office, the vault close, the China account, a missed collection showing on Today and being resolved with a note, a wallet checked against its app, a statement made, drawn and marked as sent, the checks being set, a second device signed in and signed out from the first, a payment in dollars and rounded dinars, an Error entry up to the limit and past it once the limit is raised, a stop on a round paid to the driver in two currencies and counted in, a stop 62 cents short let go from the round with one click, and, signed out, every screen and address refusing to open.

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

To see the office app, with a made-up office already in it:

```sh
pnpm db:reset
pnpm --filter @green-star/api seed-demo   # customers, files, rounds and money, all invented
pnpm --filter @green-star/api dev         # in one window
pnpm --filter @green-star/web dev         # in another: http://localhost:3000
pnpm --filter @green-star/worker dev      # in a third: the checks that follow the clock
```

The office works without the worker. What it adds are the alerts no save causes: goods held one day too long, a vault not counted by closing time, a wallet nobody checked this week. `CHECK_EVERY_SECONDS` (60) and `DEEP_CHECK_EVERY_RUNS` (15) change its pace.

Sign in as the CEO with `0770 000 0001`. The password is `greenstar-demo`. Open it as `localhost`, not `127.0.0.1`: the API only answers the address it was told the office app is on.

Statements are drawn with Chromium, and so is the end-to-end test. Install it once: `pnpm --filter @green-star/web exec playwright install chromium`. The API finds the same one. `CHROMIUM_PATH` points it at another.

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
- **Sign-in is built here, not with Better Auth.** Better Auth wants an email for every user and brings its own tables and ids. This system has one account, signs in with a phone number, and already keeps its rules in Postgres. What is built is small and each part is tested: scrypt hashes (Node's own), random session tokens stored as sha256, and the limits above.
- **One role, not three.** The board has the CEO, the owner (sees everything, changes nothing) and the office monitor (a screen with chosen widgets, no money). The CEO then said the system is his alone, so the other two were taken out everywhere: no such account can be made, the address and the screen for the monitor are gone, and nothing in the API or the screens asks what an account may do. In the database the `role` column stays, held to `ceo` by a constraint, because every row that says who did something points at a user. Both roles are in the git history before `0010_only_the_ceo.sql` if he wants one back.
- **No shadcn/ui.** The screens use a small set of components written here (`apps/web/src/components/ui.tsx`), styled with Tailwind. It is about fifteen pieces, and they give the app its own look.
- **Fonts are served by the app itself** (Archivo and IBM Plex Mono, the same as the plan boards), not fetched from Google, so the screens look the same with a slow connection.
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
- **A statement is drawn when it is asked for, by the API, and not kept as a file.** The board has the worker export it to file storage. What is kept is the statement itself, as data; the image and the PDF are drawn from it each time, and come out the same. There is no file storage to set up for it, and nothing to go missing.
- **The weekly statement list is a screen, not a job.** It is worked out when it is opened.
- **Alerts are worked out, not written by jobs.** The board has one job per check, each run at its own moment. Here one function says what is wrong now, and it is asked after every save and on a timer. A check can't be forgotten at one of its moments, and an alert goes away by itself when it stops being true.
- **An alert has a third ending the board doesn't list: `cleared`.** The board has open and resolved. A customer who pays after the driver forgot to collect should not leave an alert waiting for a note.
- **More alerts than the board's table:** a wallet gap, a dinar payment at a rate the day no longer has, and the ledger's own health check.
- **The worker is a timer, not pg-boss.** There is nothing to queue yet. A queue comes with the Excel import, which is the first job that takes long and can fail halfway.
- **The vault reminder waits for cash to move.** The board reminds at closing time every day. Here it reminds only when cash moved since the last count, and keeps reminding on the following days until the vault is counted.
- **The carton check is not tied to creating a round.** Whenever the count differs from the file there is an alert, and it goes when a "missing" dispute is opened.

## Confirmed by the CEO

- **Overpayment becomes credit.** "Customer owes $600, pays $1,000: $400 becomes credit, then later he can order and pay with that $400." It pays toward his next file by itself.
- **The rate that counts is the rate of the day the customer pays,** not the day the cargo arrived. "The day cargo arrives $100 = 152,000; the day the customer pays $100 = 155,000: this is counted."
- **Dinar rounding is normal rounding,** and the rounded dinars settle the dollars owed. $62.00 at 1,470 is 91,140 IQD: 91,000 pays it, and nothing is left owed.
- **Customers pay in dollars, dinars and FIB at once.** Dinars and FIB dinars are divided by the day's rate.
- **A small error is fixed with an entry called Error.**
- **The system is his alone.** One kind of account.

## Assumed, to confirm with the CEO

- **"Normal rounding" is to the nearest 1,000 dinars.** His one example (208,810 becomes 209,000) fits 500 and 1,000. It is a setting.
- **A rounded payment has to come within half a step of what is owed to settle it.** 208,810 owed: 208,500 and 209,000 settle it, 208,000 does not and leaves 52 cents owed. If he also takes "a bit less, let it go", that is what the Error entry is for.
- **An Error entry only takes off.** It cannot make a customer owe more, because everything a customer owes belongs to a file. Money typed for too much is fixed the way every money mistake is: reversed and entered again.
- **An Error entry is at most $5.00,** from "a $5 error or something". The limit is a setting, up to $100.
- **One visit is at most four payments,** and two payments in the same currency and the same way are added up into one.

- Wallet accounts (FIB, FastPay, ZainCash) exist in both dollars and dinars, because the board doesn't say which currency wallet payments arrive in.
- Money sent to China leaves the dollar vault.
- A phone number with no country code is read as Iraqi (+964).
- A mark prefix matches whole words: `YARO` matches `YARO-OSMAN` and `YARO 2`, but not `YARO2`.
- **The notes he counts.** Dollars: 1, 2, 5, 10, 20, 50, 100. Dinars: 250, 500, 1,000, 5,000, 10,000, 25,000, 50,000. No coins. The list is a table, so it changes without code.
- **A customer can pay by wallet at the door.** That money goes to the wallet's account, not the driver's cash.
- **Goods held in the car take no money on the round.** If he pays later, it is an office or wallet payment, and the goods go out as `paid` on the next round.
- **The vault's first close is its opening count.** Until the starting balances are loaded the ledger starts at zero, so the first count shows the whole box as a gap, with a note. Nothing else is needed to start.
- **The ledger's vault can go below zero.** A cash out typed before the hand-in that funded it is not refused. It shows in `vault_status`.

- **Statements are in English,** like the screens. A name is shown exactly as it was typed, Kurdish and Arabic included. If customers should get theirs in Kurdish, the text and the page are one file each.
- **"This week" is seven days** from when the last statement was marked as sent.
- **A statement shows a customer his files, his payments and the dinar rate each was counted at.** It does not show notes typed in the office.
- **Money leaving a wallet has no entry on the board.** A wallet account only ever goes up. When he takes cash out of FIB or sends it on, the next wallet check shows a gap, he writes where it went, and the app is expected to show the new balance from then on. This keeps the check honest but the money's path is only in the note. To decide: an entry for "wallet to vault", and whether money to China can leave a wallet.
- **The wallet check is due 7 days after the oldest money nobody has checked,** not on a fixed weekday. A wallet nobody paid into is never due.
- **Goods are held too long after 3 days,** and **the vault closes at 18:00.** Both are in Settings.
- **A resolved alert stays resolved even if it gets worse.** A customer over his limit by $50 whose alert was resolved does not raise a new one at $500 over. He raises one again after he has been back under the limit.
- **What counts as serious.** High: not collected, any cash gap, a wallet gap, the books out of step. Medium: vault not counted, cartons, over limit, held too long, old rate. Low: a wallet check that is due.

- **A password is at least 10 characters.** No other rules.
- **A session ends after 14 days without use.**
- **Wrong passwords.** 5 for one account from one address, 20 for one account from anywhere, or 30 from one address: wait 15 minutes.
- **There is one way to make an account**, the `create-ceo` command, run where the system is hosted. It also gives him a new password if he loses his. No screen adds an account, so a second person who should sign in (a second CEO) is added the same way.

## Not built yet

The Excel import and its screen (`/v1/imports`, waiting on the real China files) and the file check that runs on each import, receipts and photos (`/v1/attachments`, which needs the file storage set up), the weekly backup test (it needs the hosting), and starting balances. The columns of `shipment_lines` are provisional until the real China files arrive.
