// Checks and alerts, the Today screen, the wallet check, the office settings
// and the office monitor.
//
//   GET  /v1/alerts              CEO, owner  Open alerts, newest first (or resolved, or cleared)
//   GET  /v1/alerts/count        CEO, owner  How many are open, for the badge in the menu
//   POST /v1/alerts/:id/resolve  CEO         Close an alert with a note
//   GET  /v1/reports/today       CEO, owner  Expected vs collected vs counted, per currency
//   GET  /v1/wallets             CEO, owner  Each wallet: the books, what its app should show, the last checks
//   POST /v1/wallets/checks      CEO         What the wallet's app shows, typed in and compared
//   GET  /v1/settings            CEO, owner  Held-in-car days, close time, wallet days, monitor widgets
//   PUT  /v1/settings            CEO         Change them
//   GET  /v1/monitor             everyone    Only the widgets chosen for the office screen. No money.
//
// The alerts themselves are not made here. After every save the API asks the
// database to bring them in line with the facts (see write() in http.ts), and
// the worker asks again on a timer for the ones that depend on the clock.

import {
  AlertQuery,
  CEO_ONLY,
  EVERYONE,
  IdParams,
  READERS,
  ResolveAlertRequest,
  SettingsRequest,
  WalletCheckRequest,
  type Alert,
  type AlertCount,
  type Monitor,
  type MonitorFile,
  type MonitorHeld,
  type MonitorRound,
  type MonitorWidget,
  type Page,
  type Rate,
  type RoundSummary,
  type Settings,
  type TodayCash,
  type TodayFile,
  type TodayReport,
  type Wallet,
  type WalletCheck,
  type Wallets,
} from "@green-star/contracts";
import { baghdadDay } from "@green-star/domain";
import type { FastifyInstance } from "fastify";
import type { Queryable, Row } from "../db.ts";
import { notFound, parse } from "../errors.ts";
import { camel, happened, pager, read, write } from "../http.ts";

const ALERT_COLUMNS = `
  a.id, a.kind, a.severity, a.status, a.title, a.active as still_wrong,
  a.customer_id, cu.display_name as customer_name, a.consignment_id,
  coalesce(a.shipment_id, c.shipment_id) as shipment_id, s.code as shipment_code,
  a.round_id, r.number as round_number, a.amount, a.currency,
  a.opened_at, a.resolved_at, u.name as resolved_by_name, a.note, a.cleared_at`;

const ALERT_FROM = `
  from alerts a
  left join customers cu on cu.id = a.customer_id
  left join consignments c on c.id = a.consignment_id
  left join shipments s on s.id = coalesce(a.shipment_id, c.shipment_id)
  left join rounds r on r.id = a.round_id
  left join users u on u.id = a.resolved_by`;

const toAlert = (row: Row): Alert => camel<Alert>(row);

async function alertCount(q: Queryable): Promise<AlertCount> {
  const row = await q.first<{ open: number; high: number }>(
    "select count(*) as open, count(*) filter (where severity = 'high') as high from alerts where status = 'open'",
  );
  return { open: row?.open ?? 0, high: row?.high ?? 0 };
}

const RATES = `select f.day, f.iqd_per_100_usd, u.name as set_by, f.set_at from fx_rates f join users u on u.id = f.set_by`;

/** Rounds that are not finished, and rounds whose cash was counted in on this Baghdad day. */
const IN_PLAY = `(o.status <> 'handed_in' or (o.handed_in_at at time zone 'Asia/Baghdad')::date = $1::date)`;

async function today(q: Queryable): Promise<TodayReport> {
  const day = baghdadDay(new Date());
  const rate = await q.first(`${RATES} where f.day = $1::date`, [day]);
  const lastRate = await q.first(`${RATES} where f.day < $1::date order by f.day desc limit 1`, [day]);

  const rounds = await q.query(`select o.* from round_overview o where ${IN_PLAY} order by o.number desc`, [day]);
  const due = await q.first<{ expected: number; collected: number }>(
    `select coalesce(sum(d.remaining_usd_cents + coalesce(d.credited_usd_cents, 0)), 0) as expected,
            coalesce(sum(d.credited_usd_cents), 0) as collected
     from round_stop_details d
     join round_overview o on o.round_id = d.round_id
     where d.consignment_status <> 'cancelled' and ${IN_PLAY}`,
    [day],
  );
  const cash = await q.query<{ currency: "USD" | "IQD"; collected: number; counted: number; gap: number }>(
    `select k.currency,
            coalesce(sum(rc.collected), 0) as collected,
            coalesce(sum(rc.handed_in), 0) as counted,
            coalesce(sum(rc.gap), 0) as gap
     from (values ('USD'::currency), ('IQD'::currency)) k (currency)
     left join (round_cash rc join round_overview o on o.round_id = rc.round_id and ${IN_PLAY}) on rc.currency = k.currency
     group by k.currency order by k.currency`,
    [day],
  );
  const office = await q.value<number>(
    `select coalesce(sum(p.credited_usd_cents), 0)
     from payments p
     where p.kind in ('office_payment', 'wallet_payment') and not p.reversed
       and (p.happened_at at time zone 'Asia/Baghdad')::date = $1::date
       and not exists (select 1 from round_results rr where rr.payment_entry_id = p.entry_id)`,
    [day],
  );
  const files = await q.query(
    `select shipment_id, code, status, consignments, not_delivered, delivered_not_paid, waiting_for_hand_in, disputes_waiting,
            expected_usd_cents, collected_usd_cents
     from shipment_overview where status <> 'closed' order by created_at desc, shipment_id limit 50`,
  );
  const held = await q.value<number>("select count(*) from held_in_car");

  return {
    day,
    rate: rate === undefined ? null : camel<Rate>(rate),
    lastRate: lastRate === undefined ? null : camel<Rate>(lastRate),
    alerts: await alertCount(q),
    rounds: rounds.map((row) => camel<RoundSummary>(row, { round_id: "id" })),
    expectedUsdCents: due?.expected ?? 0,
    collectedUsdCents: due?.collected ?? 0,
    cash: cash.map((row): TodayCash => ({ currency: row.currency, collected: row.collected, counted: row.counted, gap: row.gap })),
    officePaymentsUsdCents: office,
    files: files.map((row) => camel<TodayFile>(row, { shipment_id: "id" })),
    heldInCar: held,
  };
}

async function wallets(q: Queryable): Promise<Wallets> {
  const rows = await q.query(
    `select w.code, w.name, w.method, w.currency, w.ledger_balance, w.expected_in_app,
            w.last_checked_at, w.last_difference, w.unchecked_since,
            (w.unchecked_since is not null
             and now() - w.unchecked_since >= make_interval(days => (select wallet_check_days from settings))) as check_due
     from wallet_status w order by w.code`,
  );
  const checks = await q.query(
    `select c.id, a.code, a.name, c.currency, c.app_balance, c.expected, c.difference, c.note, c.checked_at, u.name as checked_by_name
     from wallet_checks c join accounts a on a.id = c.account_id join users u on u.id = c.checked_by
     order by c.created_at desc, c.id limit 30`,
  );
  return { wallets: rows.map((row) => camel<Wallet>(row)), checks: checks.map((row) => camel<WalletCheck>(row)) };
}

async function settings(q: Queryable): Promise<Settings> {
  const row = await q.first(
    `select held_in_car_days, to_char(vault_close_time, 'HH24:MI') as vault_close_time, wallet_check_days, monitor_widgets, updated_at
     from settings`,
  );
  return camel<Settings>(row as Row);
}

async function monitor(q: Queryable): Promise<Monitor> {
  const { monitorWidgets } = await settings(q);
  const out: Monitor = { at: new Date().toISOString(), widgets: monitorWidgets };
  const shown = new Set<MonitorWidget>(monitorWidgets);

  if (shown.has("files")) {
    const rows = await q.query(
      `select code, status, consignments, consignments - not_delivered as delivered
       from shipment_overview where status <> 'closed' order by created_at desc, shipment_id limit 30`,
    );
    out.files = rows.map((row) => camel<MonitorFile>(row));
  }
  if (shown.has("rounds")) {
    const rows = await q.query(
      `select number, status, coalesce(driver_name, carrier_name) as carried_by, left_at, stops, results as done
       from round_overview where status <> 'handed_in' order by number desc limit 30`,
    );
    out.rounds = rows.map((row) => camel<MonitorRound>(row));
  }
  if (shown.has("held")) {
    const rows = await q.query(
      `select cu.display_name as customer_name, s.code as shipment_code, c.city, h.held_since
       from held_in_car h
       join consignments c on c.id = h.consignment_id
       join customers cu on cu.id = h.customer_id
       join shipments s on s.id = h.shipment_id
       order by h.held_since nulls last, c.id limit 60`,
    );
    out.held = rows.map((row) => camel<MonitorHeld>(row));
  }
  return out;
}

export async function alertRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  // -- Alerts ---------------------------------------------------------------

  app.get("/alerts", { config: { access: READERS } }, async (request): Promise<Page<Alert>> => {
    const query = parse(AlertQuery, request.query);
    // Open alerts by when they started; closed ones by when they were closed.
    const at = query.status === "open" ? "a.opened_at" : query.status === "resolved" ? "a.resolved_at" : "a.cleared_at";
    const p = pager(query, at, "a.id::text");
    const params: unknown[] = [query.status];
    let where = "a.status = $1::alert_status";
    if (query.kind !== undefined) {
      params.push(query.kind);
      where += ` and a.kind = $${params.length}::alert_kind`;
    }
    const rows = await read(ctx, (q) =>
      q.query(`select ${ALERT_COLUMNS}, ${p.columns} ${ALERT_FROM} where ${where} ${p.where(params)} ${p.orderAndLimit(params)}`, params),
    );
    return p.page(rows, toAlert);
  });

  app.get("/alerts/count", { config: { access: READERS } }, async (): Promise<AlertCount> => read(ctx, alertCount));

  app.post("/alerts/:id/resolve", { config: { access: CEO_ONLY } }, async (request, reply): Promise<Alert> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(ResolveAlertRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      await q.query("select gs_resolve_alert($1, $2, $3)", [id, auth.user.id, body.note]);
      const row = await q.first(`select ${ALERT_COLUMNS} ${ALERT_FROM} where a.id = $1`, [id]);
      if (row === undefined) throw notFound("That alert");
      return { body: toAlert(row) };
    });
  });

  // -- Today ----------------------------------------------------------------

  app.get("/reports/today", { config: { access: READERS } }, async (): Promise<TodayReport> => read(ctx, today));

  // -- Wallets --------------------------------------------------------------

  app.get("/wallets", { config: { access: READERS } }, async (): Promise<Wallets> => read(ctx, wallets));

  app.post("/wallets/checks", { config: { access: CEO_ONLY } }, async (request, reply): Promise<Wallets> => {
    const body = parse(WalletCheckRequest, request.body);
    const at = happened(body.checkedAt, "checkedAt");
    return write(ctx, request, reply, async ({ q, auth }) => {
      await q.query("select gs_check_wallet($1, $2, $3, $4, $5, $6)", [body.id, body.wallet, auth.user.id, body.appBalance, at, body.note ?? null]);
      return { status: 201, body: await wallets(q) };
    });
  });

  // -- Settings -------------------------------------------------------------

  app.get("/settings", { config: { access: READERS } }, async (): Promise<Settings> => read(ctx, settings));

  app.put("/settings", { config: { access: CEO_ONLY } }, async (request, reply): Promise<Settings> => {
    const body = parse(SettingsRequest, request.body);
    return write(ctx, request, reply, async ({ q }) => {
      await q.query(
        `update settings
            set held_in_car_days = coalesce($1::integer, held_in_car_days),
                vault_close_time = coalesce($2::time, vault_close_time),
                wallet_check_days = coalesce($3::integer, wallet_check_days),
                monitor_widgets = coalesce($4::text[], monitor_widgets),
                updated_at = now()`,
        [body.heldInCarDays ?? null, body.vaultCloseTime ?? null, body.walletCheckDays ?? null, body.monitorWidgets ?? null],
      );
      return { body: await settings(q) };
    });
  });

  // -- The office monitor ---------------------------------------------------

  app.get("/monitor", { config: { access: EVERYONE } }, async (): Promise<Monitor> => read(ctx, monitor));
}
