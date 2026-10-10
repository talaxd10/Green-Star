// The driver's own account, and what delivery costs.
//
//   GET  /v1/driver-accounts            Every driver with the office's money he holds
//   GET  /v1/drivers/:id/account        His account, line by line
//   POST /v1/drivers/:id/money          Money given to him, a receipt he brought back, or money he gave back
//   GET  /v1/reports/delivery-costs     Every expense, counted in dollars, next to what was delivered
//
// Before the driver leaves, the CEO gives him money for the road (advance).
// When he is back, each receipt is entered (expense: fuel, car parts,
// workers, a transport company between cities). Change he gave a customer at
// the door comes off his account by itself, from the round's results. What
// he did not spend he gives back, or keeps for the next round.

import { DeliveryCostsQuery, DriverMoneyRequest, IdParams, type DeliveryCosts, type DriverAccount, type DriverAccountDetail, type DriverAccountLine } from "@green-star/contracts";
import { baghdadDay } from "@green-star/domain";
import type { FastifyInstance } from "fastify";
import type { Queryable, Row } from "../db.ts";
import { notFound, parse } from "../errors.ts";
import { camel, happened, read, write } from "../http.ts";

const ACCOUNT = "select driver_id, name, phone, active, holds_usd_cents, holds_iqd, last_moved_at from driver_accounts";

const KIND: Record<string, DriverAccountLine["kind"]> = {
  driver_advance: "advance",
  driver_expense: "expense",
  driver_return: "return",
  driver_collected: "change",
};

async function account(q: Queryable, driverId: string): Promise<DriverAccountDetail> {
  const row = await q.first(`${ACCOUNT} where driver_id = $1`, [driverId]);
  if (row === undefined) throw notFound("That driver");
  const lines = await q.query(
    `select l.entry_id, l.kind, l.currency, l.amount, l.balance_after, l.category, l.round_id, r.number as round_number,
            l.city, l.note, l.customer_name, l.happened_at, l.is_reversal, l.reversed
     from driver_account_lines l left join rounds r on r.id = l.round_id
     where l.driver_id = $1
     order by l.happened_at desc, l.created_at desc, l.line_id desc
     limit 300`,
    [driverId],
  );
  return {
    ...camel<DriverAccount>(row),
    lines: lines.map((line) => ({ ...camel<DriverAccountLine>(line), kind: KIND[line.kind as string] ?? "expense" })),
  };
}

const sumLine = (row: Row | undefined) => ({
  usdCents: Number(row?.usd_cents ?? 0),
  usdPaid: Number(row?.usd_paid ?? 0),
  iqdPaid: Number(row?.iqd_paid ?? 0),
});

const SUMS = `coalesce(sum(usd_cents), 0) as usd_cents,
              coalesce(sum(amount) filter (where currency = 'USD'), 0) as usd_paid,
              coalesce(sum(amount) filter (where currency = 'IQD'), 0) as iqd_paid`;

/** The first day of the month five months ago, to today: half a year. */
function defaultRange(): { from: string; to: string } {
  const to = baghdadDay(new Date());
  const [y, m] = to.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1 - 5, 1));
  return { from: start.toISOString().slice(0, 10), to };
}

async function deliveryCosts(q: Queryable, from: string, to: string): Promise<DeliveryCosts> {
  const span = [from, to];
  const totals = await q.query(`select delivery, ${SUMS} from expense_lines where day between $1 and $2 group by delivery`, span);
  const delivered = await q.first<{ rounds: string; customers: string; weight: string }>(
    `select count(distinct round_id) as rounds, count(*) as customers, coalesce(sum(weight_grams), 0) as weight
     from delivered_goods where day between $1 and $2`,
    span,
  );
  const byCategory = await q.query(
    `select c.code as category, c.label, c.delivery, ${SUMS}
     from expense_categories c left join expense_lines x on x.category = c.code and x.day between $1 and $2
     group by c.code, c.label, c.delivery, c.sort order by c.sort`,
    span,
  );
  const byMonth = await q.query(
    `with spent as (select to_char(day, 'YYYY-MM') as month, ${SUMS} from expense_lines where delivery and day between $1 and $2 group by 1),
          done as (select to_char(day, 'YYYY-MM') as month, count(*) as customers, count(distinct round_id) as rounds
                   from delivered_goods where day between $1 and $2 group by 1)
     select coalesce(s.month, d.month) as month, s.usd_cents, s.usd_paid, s.iqd_paid,
            coalesce(d.customers, 0) as customers, coalesce(d.rounds, 0) as rounds
     from spent s full join done d on d.month = s.month order by 1`,
    span,
  );
  const byCity = await q.query(
    `with spent as (select coalesce(nullif(btrim(city), ''), 'City not said') as city, ${SUMS}
                    from expense_lines where delivery and day between $1 and $2 group by 1),
          done as (select coalesce(nullif(btrim(city), ''), 'City not said') as city, count(*) as customers
                   from delivered_goods where day between $1 and $2 group by 1)
     select coalesce(s.city, d.city) as city, s.usd_cents, s.usd_paid, s.iqd_paid, coalesce(d.customers, 0) as customers
     from spent s full join done d on d.city = s.city order by coalesce(s.usd_cents, 0) desc, 1`,
    span,
  );
  const byRound = await q.query(
    `with spent as (select round_id, ${SUMS} from expense_lines where delivery and round_id is not null and day between $1 and $2 group by 1),
          done as (select round_id, count(*) as customers from delivered_goods where day between $1 and $2 group by 1)
     select r.id as round_id, r.number, dr.name as driver_name, ca.name as carrier_name, r.left_at,
            s.usd_cents, s.usd_paid, s.iqd_paid, coalesce(d.customers, 0) as customers
     from (select round_id from spent union select round_id from done) ids
     join rounds r on r.id = ids.round_id
     left join drivers dr on dr.id = r.driver_id
     left join carriers ca on ca.id = r.carrier_id
     left join spent s on s.round_id = r.id
     left join done d on d.round_id = r.id
     order by r.number desc
     limit 200`,
    span,
  );
  const noRate = await q.query<{ day: string }>(
    `select distinct to_char(x.day, 'YYYY-MM-DD') as day from expense_lines x
     where x.currency = 'IQD' and x.day between $1 and $2 and not exists (select 1 from fx_rates f where f.day = x.day)
     order by 1`,
    span,
  );

  const delivery = sumLine(totals.find((t) => t.delivery === true));
  const other = sumLine(totals.find((t) => t.delivery === false));
  const customers = Number(delivered?.customers ?? 0);
  const weightGrams = Number(delivered?.weight ?? 0);
  return {
    from,
    to,
    delivery,
    other,
    delivered: { rounds: Number(delivered?.rounds ?? 0), customers, weightGrams },
    perDeliveryUsdCents: customers === 0 ? null : Math.round(delivery.usdCents / customers),
    perKgUsdCents: weightGrams === 0 ? null : Math.round((delivery.usdCents * 1000) / weightGrams),
    byCategory: byCategory.map((row) => ({ ...sumLine(row), category: row.category as DeliveryCosts["byCategory"][number]["category"], label: row.label as string, delivery: row.delivery as boolean })),
    byMonth: byMonth.map((row) => ({ ...sumLine(row), month: row.month as string, deliveredCustomers: Number(row.customers), rounds: Number(row.rounds) })),
    byCity: byCity.map((row) => ({ ...sumLine(row), city: row.city as string, deliveredCustomers: Number(row.customers) })),
    byRound: byRound.map((row) => ({
      ...sumLine(row),
      roundId: row.round_id as string,
      number: Number(row.number),
      driverName: (row.driver_name as string | null) ?? null,
      carrierName: (row.carrier_name as string | null) ?? null,
      leftAt: row.left_at === null ? null : (row.left_at as Date).toISOString(),
      deliveredCustomers: Number(row.customers),
    })),
    daysWithoutRate: noRate.map((row) => row.day),
  };
}

export async function driverRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.get("/driver-accounts", { config: { access: "signed_in" } }, async (): Promise<{ items: DriverAccount[] }> => {
    const rows = await read(ctx, (q) => q.query(`${ACCOUNT} order by active desc, name, driver_id`));
    return { items: rows.map((row) => camel<DriverAccount>(row)) };
  });

  app.get("/drivers/:id/account", { config: { access: "signed_in" } }, async (request): Promise<DriverAccountDetail> => {
    const { id } = parse(IdParams, request.params);
    return read(ctx, (q) => account(q, id));
  });

  app.post("/drivers/:id/money", { config: { access: "signed_in" } }, async (request, reply): Promise<DriverAccountDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(DriverMoneyRequest, request.body);
    const at = happened(body.happenedAt);
    return write(ctx, request, reply, async ({ q, auth, key }) => {
      if ((await q.first("select 1 from drivers where id = $1", [id])) === undefined) throw notFound("That driver");
      await q.query("select gs_driver_money($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)", [
        `api:${key}`,
        body.what,
        id,
        body.amount.currency,
        body.amount.amount,
        auth.user.id,
        at,
        body.category ?? null,
        body.roundId ?? null,
        body.city ?? null,
        body.note ?? null,
      ]);
      return { status: 201, body: await account(q, id) };
    });
  });

  app.get("/reports/delivery-costs", { config: { access: "signed_in" } }, async (request): Promise<DeliveryCosts> => {
    const query = parse(DeliveryCostsQuery, request.query);
    const range = defaultRange();
    const from = query.from ?? range.from;
    const to = query.to ?? range.to;
    return read(ctx, (q) => deliveryCosts(q, from <= to ? from : to, from <= to ? to : from));
  });
}
