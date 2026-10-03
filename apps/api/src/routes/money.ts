// Money at the office.
//
//   GET  /v1/fx-rates/today           CEO, owner  Today's rate, and the last one set
//   GET  /v1/fx-rates                 CEO, owner  Rates by day
//   PUT  /v1/fx-rates/:day            CEO         Set a day's dinar rate ("today" or a date)
//   GET  /v1/payments                 CEO, owner  Customer payments, with how each was paid
//   POST /v1/payments                 CEO         Office or wallet payment, applied to the oldest unpaid
//   GET  /v1/cash-outs                CEO, owner  Cash paid out of the vault
//   POST /v1/cash-outs                CEO         China, driver pay, fuel and car, customs and airport, rent and salaries, other
//   POST /v1/exchanges                CEO         Dinars changed into dollars, or back
//   GET  /v1/vault                    CEO, owner  What should be in the box, the notes, and the last closes
//   POST /v1/vault/close              CEO         Daily count by denomination per currency
//   POST /v1/vault/closes/:id/void    CEO         Take a wrong count back
//   POST /v1/entries/:id/reverse      CEO         Reverse a mistake with a reason
//   GET  /v1/entries/:id              CEO, owner  One entry with its lines
//   GET  /v1/ledger                   CEO, owner  Entries by account and date
//   GET  /v1/accounts                 CEO, owner  Every account and what is on it
//   GET  /v1/china-account            CEO, owner  Owed to China vs sent

import {
  CashOutQuery,
  CEO_ONLY,
  ChinaAccountQuery,
  IdParams,
  LedgerQuery,
  NewCashOutRequest,
  NewExchangeRequest,
  NewPaymentRequest,
  PaymentQuery,
  RateDayParams,
  RateQuery,
  READERS,
  ReverseRequest,
  SetRateRequest,
  VaultCloseRequest,
  VoidRequest,
  type Account,
  type CashOut,
  type ChinaAccount,
  type ChinaAccountLine,
  type Denomination,
  type Entry,
  type EntryLine,
  type Page,
  type Payment,
  type Rate,
  type RateToday,
  type Vault,
  type VaultClose,
  type VaultCurrency,
} from "@green-star/contracts";
import {
  baghdadDay,
  cashOut,
  currencyExchange,
  currencyExchangeToDinars,
  money,
  officePayment,
  sentToChina,
  walletPayment,
  type EntryDraft,
} from "@green-star/domain";
import type { FastifyInstance } from "fastify";
import type { Queryable, Row } from "../db.ts";
import { ApiError, notFound, parse } from "../errors.ts";
import { camel, dayRange, happened, pager, read, write } from "../http.ts";
import { dayRate, postEntry } from "../ledger.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toRate = (row: Row): Rate => camel<Rate>(row);
const toPayment = (row: Row): Payment => camel<Payment>(row);
const toCashOut = (row: Row): CashOut => camel<CashOut>(row);

const RATES = `select f.day, f.iqd_per_100_usd, u.name as set_by, f.set_at from fx_rates f join users u on u.id = f.set_by`;

const PAYMENTS = `
  select p.entry_id, p.customer_id, c.display_name as customer_name, p.kind, p.method, p.received_amount, p.received_currency,
         p.iqd_per_100_usd, p.credited_usd_cents, p.happened_at, p.created_at, p.note,
         -- The round a payment was taken on, whether it was cash to the driver or a wallet at the door.
         coalesce(p.round_id, (select r.round_id from round_results r where r.payment_entry_id = p.entry_id)) as round_id,
         p.paid_for_consignment_id, p.reversed
  from payments p join customers c on c.id = p.customer_id`;

/** Entries with their lines, in the order asked for. */
async function entriesById(q: Queryable, ids: readonly string[]): Promise<Entry[]> {
  if (ids.length === 0) return [];
  const entries = await q.query<Row & { id: string }>(
    `select e.id, e.kind, e.happened_at, e.created_at, e.created_by, u.name as created_by_name, e.reason, e.reverses_id,
            (select r.id from journal_entries r where r.reverses_id = e.id) as reversed_by_id, e.iqd_per_100_usd
     from journal_entries e join users u on u.id = e.created_by
     where e.id = any($1::uuid[])`,
    [ids],
  );
  const lines = await q.query<Row & { entry_id: string }>(
    `select l.entry_id, l.account_id, a.code as account_code, a.kind as account_kind, a.name as account_name, l.currency, l.amount
     from journal_lines l join accounts a on a.id = l.account_id
     where l.entry_id = any($1::uuid[]) order by l.id`,
    [ids],
  );
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return ids.flatMap((id) => {
    const entry = byId.get(id);
    if (entry === undefined) return [];
    return [
      {
        ...camel<Omit<Entry, "lines">>(entry),
        lines: lines.filter((line) => line.entry_id === id).map((line) => camel<EntryLine>({ ...line, entry_id: undefined })),
      },
    ];
  });
}

async function vault(q: Queryable): Promise<Vault> {
  const currencies = await q.query("select * from vault_status order by currency");
  const denominations = await q.query("select currency, value, label from cash_denominations order by currency, value desc");
  const closes = await q.query<Row & { close_id: string; day: string; closed_at: Date; note: string | null; voided: boolean }>(
    "select * from vault_close_details order by closed_at desc limit 30",
  );
  return {
    currencies: currencies.map((row) => camel<VaultCurrency>(row)),
    denominations: denominations.map((row) => camel<Denomination>(row)),
    closes: closes.map(
      (c): VaultClose => ({
        id: c.close_id,
        day: c.day,
        closedAt: c.closed_at.toISOString(),
        note: c.note,
        voided: c.voided,
        usd: { notes: c.usd_notes as Record<string, number>, counted: c.usd_counted as number, expected: c.usd_expected as number, difference: c.usd_difference as number },
        iqd: { notes: c.iqd_notes as Record<string, number>, counted: c.iqd_counted as number, expected: c.iqd_expected as number, difference: c.iqd_difference as number },
      }),
    ),
  };
}

export async function moneyRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  // -- The day's rate -------------------------------------------------------

  app.get("/fx-rates/today", { config: { access: READERS } }, async (): Promise<RateToday> => {
    const day = baghdadDay(new Date());
    return read(ctx, async (q) => {
      const rate = await q.first(`${RATES} where f.day = $1::date`, [day]);
      const last = await q.first(`${RATES} where f.day < $1::date order by f.day desc limit 1`, [day]);
      return { day, rate: rate === undefined ? null : toRate(rate), last: last === undefined ? null : toRate(last) };
    });
  });

  app.get("/fx-rates", { config: { access: READERS } }, async (request): Promise<{ items: Rate[] }> => {
    const query = parse(RateQuery, request.query);
    const rows = await read(ctx, (q) =>
      q.query(
        `${RATES} where ($1::date is null or f.day >= $1::date) and ($2::date is null or f.day <= $2::date) order by f.day desc limit 400`,
        [query.from ?? null, query.to ?? null],
      ),
    );
    return { items: rows.map(toRate) };
  });

  app.put("/fx-rates/:day", { config: { access: CEO_ONLY } }, async (request, reply): Promise<Rate> => {
    const params = parse(RateDayParams, request.params);
    const body = parse(SetRateRequest, request.body);
    const today = baghdadDay(new Date());
    const day = params.day === "today" ? today : params.day;
    if (day > today) {
      throw new ApiError(400, "invalid_request", "day: That day has not come yet", { fields: { day: "That day has not come yet" } });
    }
    return write(ctx, request, reply, async ({ q, auth }) => {
      await q.query("select gs_set_rate($1::date, $2, $3, $4)", [day, body.iqdPer100Usd, auth.user.id, body.confirm]);
      const row = await q.first(`${RATES} where f.day = $1::date`, [day]);
      return { body: toRate(row as Row) };
    });
  });

  // -- Payments -------------------------------------------------------------

  app.get("/payments", { config: { access: READERS } }, async (request): Promise<Page<Payment>> => {
    const query = parse(PaymentQuery, request.query);
    const p = pager(query, "p.created_at", "p.entry_id::text");
    const params: unknown[] = [];
    let where = "";
    if (query.customerId !== undefined) {
      params.push(query.customerId);
      where += ` and p.customer_id = $${params.length}`;
    }
    where += dayRange(params, "p.happened_at", query.from, query.to);
    const rows = await read(ctx, (q) =>
      q.query(`${PAYMENTS.replace("select ", `select ${p.columns}, `)} where true ${where} ${p.where(params)} ${p.orderAndLimit(params)}`, params),
    );
    return p.page(rows, toPayment);
  });

  app.post("/payments", { config: { access: CEO_ONLY } }, async (request, reply): Promise<Payment> => {
    const body = parse(NewPaymentRequest, request.body);
    const at = happened(body.happenedAt);
    const received = money(body.received.amount, body.received.currency);
    return write(ctx, request, reply, async ({ q, auth, key }) => {
      const customer = await q.first("select 1 from customers where id = $1 and merged_into is null", [body.customerId]);
      if (customer === undefined) throw notFound("That customer");
      const ratePer100 = received.currency === "IQD" ? await dayRate(q, at) : undefined;
      const input = { customerId: body.customerId, received, ...(ratePer100 === undefined ? {} : { ratePer100 }) };
      const draft =
        body.method === "office_cash" ? officePayment(input) : walletPayment({ ...input, wallet: body.method });
      const entryId = await postEntry(q, draft, {
        happenedAt: at,
        createdBy: auth.user.id,
        key: `api:${key}`,
        forConsignment: body.forConsignmentId,
        reason: body.note,
      });
      const row = await q.first(`${PAYMENTS} where p.entry_id = $1`, [entryId]);
      return { status: 201, body: toPayment(row as Row) };
    });
  });

  // -- Cash out and exchange ------------------------------------------------

  app.get("/cash-outs", { config: { access: READERS } }, async (request): Promise<Page<CashOut>> => {
    const query = parse(CashOutQuery, request.query);
    const p = pager(query, "e.created_at", "c.entry_id::text");
    const params: unknown[] = [];
    const where = dayRange(params, "c.happened_at", query.from, query.to);
    const rows = await read(ctx, (q) =>
      q.query(
        `select c.entry_id, c.happened_at, c.day, c.category, c.amount, c.currency, c.reason, c.reversed, ${p.columns}
         from cash_outs c join journal_entries e on e.id = c.entry_id
         where true ${where} ${p.where(params)} ${p.orderAndLimit(params)}`,
        params,
      ),
    );
    return p.page(rows, toCashOut);
  });

  app.post("/cash-outs", { config: { access: CEO_ONLY } }, async (request, reply): Promise<CashOut> => {
    const body = parse(NewCashOutRequest, request.body);
    const at = happened(body.happenedAt);
    const amount = money(body.amount.amount, body.amount.currency);
    return write(ctx, request, reply, async ({ q, auth, key }) => {
      const draft: EntryDraft =
        body.category === "china"
          ? { ...sentToChina({ amountUsdCents: amount.amount }), reason: body.reason }
          : cashOut({ category: body.category, amount, reason: body.reason });
      const entryId = await postEntry(q, draft, { happenedAt: at, createdBy: auth.user.id, key: `api:${key}` });
      const row = await q.first("select entry_id, happened_at, day, category, amount, currency, reason, reversed from cash_outs where entry_id = $1", [entryId]);
      return { status: 201, body: toCashOut(row as Row) };
    });
  });

  app.post("/exchanges", { config: { access: CEO_ONLY } }, async (request, reply): Promise<Entry> => {
    const body = parse(NewExchangeRequest, request.body);
    const at = happened(body.happenedAt);
    return write(ctx, request, reply, async ({ q, auth, key }) => {
      const draft =
        body.given.currency === "IQD"
          ? currencyExchange({ iqdGiven: BigInt(body.given.amount), usdCentsReceived: BigInt(body.received.amount) })
          : currencyExchangeToDinars({ usdCentsGiven: BigInt(body.given.amount), iqdReceived: BigInt(body.received.amount) });
      const entryId = await postEntry(q, draft, { happenedAt: at, createdBy: auth.user.id, key: `api:${key}` });
      const [entry] = await entriesById(q, [entryId]);
      return { status: 201, body: entry as Entry };
    });
  });

  // -- The vault ------------------------------------------------------------

  app.get("/vault", { config: { access: READERS } }, async (): Promise<Vault> => read(ctx, vault));

  app.post("/vault/close", { config: { access: CEO_ONLY } }, async (request, reply): Promise<Vault> => {
    const body = parse(VaultCloseRequest, request.body);
    const at = happened(body.closedAt, "closedAt");
    return write(ctx, request, reply, async ({ q, auth }) => {
      await q.query("select gs_close_vault($1, $2, $3, $4::jsonb, $5::jsonb, $6)", [
        body.id,
        auth.user.id,
        at,
        body.usdNotes === undefined ? null : JSON.stringify(body.usdNotes),
        body.iqdNotes === undefined ? null : JSON.stringify(body.iqdNotes),
        body.note ?? null,
      ]);
      return { status: 201, body: await vault(q) };
    });
  });

  app.post("/vault/closes/:id/void", { config: { access: CEO_ONLY } }, async (request, reply): Promise<Vault> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(VoidRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      await q.query("select gs_void_vault_close($1, $2, $3)", [id, auth.user.id, body.reason]);
      return { body: await vault(q) };
    });
  });

  // -- The ledger -----------------------------------------------------------

  app.post("/entries/:id/reverse", { config: { access: CEO_ONLY } }, async (request, reply): Promise<Entry> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(ReverseRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth, key }) => {
      const reversal = await q.value<string>("select gs_reverse_entry($1, $2, $3, $4)", [id, auth.user.id, body.reason, `api:${key}`]);
      const [entry] = await entriesById(q, [reversal]);
      return { status: 201, body: entry as Entry };
    });
  });

  app.get("/entries/:id", { config: { access: READERS } }, async (request): Promise<Entry> => {
    const { id } = parse(IdParams, request.params);
    const [entry] = await read(ctx, (q) => entriesById(q, [id]));
    if (entry === undefined) throw notFound("That entry");
    return entry;
  });

  app.get("/ledger", { config: { access: READERS } }, async (request): Promise<Page<Entry>> => {
    const query = parse(LedgerQuery, request.query);
    const p = pager(query, "e.created_at", "e.id::text");
    const params: unknown[] = [];
    let where = "";
    if (query.account !== undefined) {
      params.push(query.account);
      const column = UUID.test(query.account) ? "a.id::text" : "a.code";
      where += ` and exists (select 1 from journal_lines l join accounts a on a.id = l.account_id
                             where l.entry_id = e.id and ${column} = $${params.length})`;
    }
    if (query.customerId !== undefined) {
      params.push(query.customerId);
      where += ` and exists (select 1 from journal_lines l join accounts a on a.id = l.account_id
                             where l.entry_id = e.id and a.customer_id = $${params.length})`;
    }
    if (query.kind !== undefined) {
      params.push(query.kind);
      where += ` and e.kind = $${params.length}::entry_kind`;
    }
    where += dayRange(params, "e.happened_at", query.from, query.to);

    return read(ctx, async (q) => {
      const rows = await q.query<Row & { id: string }>(
        `select e.id, ${p.columns} from journal_entries e where true ${where} ${p.where(params)} ${p.orderAndLimit(params)}`,
        params,
      );
      const page = p.page(rows, (row) => row.id);
      const entries = await entriesById(q, page.items);
      return { items: entries, nextCursor: page.nextCursor };
    });
  });

  app.get("/accounts", { config: { access: READERS } }, async (): Promise<{ items: Account[] }> => {
    const rows = await read(ctx, (q) =>
      q.query("select * from account_overview where kind <> 'customer' order by kind, code nulls last, name, account_id"),
    );
    return { items: rows.map((row) => camel<Account>(row, { account_id: "id" })) };
  });

  app.get("/china-account", { config: { access: READERS } }, async (request): Promise<ChinaAccount> => {
    const query = parse(ChinaAccountQuery, request.query);
    // Lines are paged by their place in the account, so "owed after" always
    // reads in order. The cursor is the place of the last line shown.
    const before = query.cursor === undefined ? null : Number(query.cursor);
    if (before !== null && (!Number.isSafeInteger(before) || before < 1)) {
      throw new ApiError(400, "invalid_request", "cursor: That is not a cursor this list gave out", {
        fields: { cursor: "That is not a cursor this list gave out" },
      });
    }
    const params: unknown[] = [before, query.limit + 1];
    const where = dayRange(params, "c.happened_at", query.from, query.to);
    return read(ctx, async (q) => {
      const summary = await q.first<{ owed_usd_cents: number; charged_usd_cents: number; sent_usd_cents: number }>(
        "select owed_usd_cents, charged_usd_cents, sent_usd_cents from china_account_summary",
      );
      const byDay = await q.query("select day, charged_usd_cents, sent_usd_cents, owed_after_usd_cents from china_account_by_day order by day desc limit 60");
      const rows = await q.query<Row & { position: number }>(
        `select c.entry_id, c.happened_at, c.day, c.kind, c.is_reversal, c.owed_change_usd_cents, c.owed_after_usd_cents,
                c.shipment_code, c.customer_id, c.reason, c.position
         from china_account c
         where ($1::bigint is null or c.position < $1) ${where}
         order by c.position desc limit $2`,
        params,
      );
      const more = rows.length > query.limit;
      const shown = more ? rows.slice(0, query.limit) : rows;
      const last = shown[shown.length - 1];
      return {
        owedUsdCents: summary?.owed_usd_cents ?? 0,
        chargedUsdCents: summary?.charged_usd_cents ?? 0,
        sentUsdCents: summary?.sent_usd_cents ?? 0,
        byDay: byDay.map((row) => camel<ChinaAccount["byDay"][number]>(row)),
        lines: shown.map((row) => camel<ChinaAccountLine>({ ...row, position: undefined })),
        nextCursor: more && last !== undefined ? String(last.position) : null,
      };
    });
  });
}
