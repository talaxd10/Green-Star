// Statements: what a customer owes and how it came about, and the copy the
// CEO makes to send him.
//
//   GET  /v1/customers/:id/statement         Every charge and payment with a running balance
//   POST /v1/customers/:id/statement/export  Make the copy to send: image, PDF and text
//   GET  /v1/customers/:id/statements        The copies made for this customer, newest first
//   GET  /v1/statements                      Who to send one to: trusted customers who owe
//   GET  /v1/statements/:id                  One copy, as it was made
//   GET  /v1/statements/:id/image            It, as a PNG
//   GET  /v1/statements/:id/pdf              It, as a PDF
//   POST /v1/statements/:id/sent             He sent it
//
// Nothing here works anything out. The lines and their running balance come
// from gs_customer_statement; the image, the PDF and the text are all made
// from the one copy the database keeps.

import {
  ExportStatementRequest,
  IdParams,
  StatementQuery,
  type Statement,
  type StatementLine,
  type StatementListItem,
  type StatementOpenFile,
  type StatementRecord,
} from "@green-star/contracts";
import type { FastifyInstance } from "fastify";
import type { Queryable, Row } from "../db.ts";
import { ApiError, notFound, parse } from "../errors.ts";
import { camel, read, write } from "../http.ts";
import { statementHtml, statementText } from "../statement.ts";

/** A copy to send shows this many lines at most. Older ones are summed into "balance before". */
const LINES_TO_SEND = 40;
/** The screen refuses to draw an account longer than this in one go. `from` shortens it. */
const LINES_TO_READ = 5000;

interface StatementRow extends Row {
  entry_id: string;
  what: string;
  is_reversal: boolean;
  is_correction: boolean;
  happened_at: Date;
  day: string;
  change_usd_cents: number;
  balance_after_usd_cents: number;
  reason: string | null;
  consignment_id: string | null;
  shipment_id: string | null;
  shipment_code: string | null;
  method: StatementLine["method"];
  received_amount: number | null;
  received_currency: StatementLine["receivedCurrency"];
  iqd_per_100_usd: number | null;
  round_id: string | null;
}

const toLine = (row: StatementRow): StatementLine => ({
  entryId: row.entry_id,
  day: row.day,
  happenedAt: row.happened_at.toISOString(),
  kind: row.what === "file_confirmed" ? "charge" : row.what === "error_correction" ? "correction" : "payment",
  isReversal: row.is_reversal,
  isCorrection: row.is_correction,
  changeUsdCents: row.change_usd_cents,
  balanceAfterUsdCents: row.balance_after_usd_cents,
  shipmentId: row.shipment_id,
  shipmentCode: row.shipment_code,
  consignmentId: row.consignment_id,
  method: row.method,
  receivedAmount: row.received_amount,
  receivedCurrency: row.received_currency,
  iqdPer100Usd: row.iqd_per_100_usd,
  roundId: row.round_id,
  note: row.reason,
});

interface StatementOptions {
  from?: string | undefined;
  corrections?: boolean;
  /** Keep only the latest lines, and sum the rest into the opening balance. */
  latest?: number;
}

async function buildStatement(q: Queryable, customerId: string, options: StatementOptions = {}): Promise<Statement> {
  const customer = await q.first<{ display_name: string; phone: string | null; trust: Statement["trust"]; credit_limit_usd_cents: number | null; balance_usd_cents: number }>(
    "select display_name, phone, trust, credit_limit_usd_cents, balance_usd_cents from customer_overview where customer_id = $1",
    [customerId],
  );
  if (customer === undefined) throw notFound("That customer");
  const asOf = await q.value<Date>("select now()");

  const rows = await q.query<StatementRow>(
    "select * from gs_customer_statement($1, $2) order by line_no limit $3",
    [customerId, options.corrections ?? false, LINES_TO_READ + 1],
  );
  if (rows.length > LINES_TO_READ) {
    throw new ApiError(422, "statement_too_long", `This account has more than ${LINES_TO_READ} lines. Pick a day to start from.`);
  }

  // Where the lines shown begin: at the first one on or after `from`, and no further back than `latest` lines.
  let first = options.from === undefined ? 0 : rows.findIndex((row) => row.day >= (options.from as string));
  if (first === -1) first = rows.length;
  if (options.latest !== undefined) first = Math.max(first, rows.length - options.latest);
  const shown = rows.slice(first);
  const opening = first === 0 ? 0 : (rows[first - 1] as StatementRow).balance_after_usd_cents;

  const open = await q.query(
    `select consignment_id, shipment_id, shipment_code, (confirmed_at at time zone 'Asia/Baghdad')::date as day, status,
            amount_due_usd_cents as due_usd_cents, paid_usd_cents, remaining_usd_cents
     from consignment_details
     where customer_id = $1 and status <> 'cancelled' and remaining_usd_cents > 0
     order by confirmed_at, created_at, consignment_id`,
    [customerId],
  );
  // The last money that came in: not something taken back, and not an Error entry.
  const lastPayment = [...rows].reverse().find((row) => row.change_usd_cents < 0 && !row.is_correction && row.what !== "error_correction");

  return {
    customerId,
    customerName: customer.display_name,
    phone: customer.phone,
    trust: customer.trust,
    creditLimitUsdCents: customer.credit_limit_usd_cents,
    asOf: asOf.toISOString(),
    balanceUsdCents: customer.balance_usd_cents,
    from: options.from ?? null,
    openingBalanceUsdCents: opening,
    chargedUsdCents: shown.reduce((sum, row) => sum + Math.max(row.change_usd_cents, 0), 0),
    paidUsdCents: shown.reduce((sum, row) => sum + Math.max(-row.change_usd_cents, 0), 0),
    lines: shown.map(toLine),
    open: open.map((row) => camel<StatementOpenFile>(row)),
    lastPayment: lastPayment === undefined ? null : { day: lastPayment.day, amountUsdCents: -lastPayment.change_usd_cents },
  };
}

const RECORDS = `
  select s.id, s.customer_id, c.display_name as customer_name, s.as_of, s.from_day, s.balance_usd_cents, s.summary,
         u.name as created_by_name, s.sent_at, su.name as sent_by_name
  from statements s
  join customers c on c.id = s.customer_id
  join users u on u.id = s.created_by
  left join users su on su.id = s.sent_by`;

const toRecord = (row: Row): StatementRecord => ({
  ...camel<Omit<StatementRecord, "imageUrl" | "pdfUrl">>(row, { from_day: "from", summary: "text" }),
  imageUrl: `/v1/statements/${row.id as string}/image`,
  pdfUrl: `/v1/statements/${row.id as string}/pdf`,
});

async function record(q: Queryable, id: string): Promise<StatementRecord> {
  const row = await q.first(`${RECORDS} where s.id = $1`, [id]);
  if (row === undefined) throw notFound("That statement");
  return toRecord(row);
}

/** The statement exactly as it was made, to draw from. */
async function snapshot(q: Queryable, id: string): Promise<Statement> {
  const row = await q.first<{ snapshot: Statement }>("select snapshot from statements where id = $1", [id]);
  if (row === undefined) throw notFound("That statement");
  return row.snapshot;
}

export async function statementRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.get("/customers/:id/statement", { config: { access: "signed_in" } }, async (request): Promise<Statement> => {
    const { id } = parse(IdParams, request.params);
    const query = parse(StatementQuery, request.query);
    return read(ctx, (q) => buildStatement(q, id, { from: query.from, corrections: query.corrections }));
  });

  app.post("/customers/:id/statement/export", { config: { access: "signed_in" } }, async (request, reply): Promise<StatementRecord> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(ExportStatementRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      // Locked before it is read, so no payment lands between working the statement out and keeping it.
      await q.query("select gs_lock_customer($1)", [id]);
      const made = await buildStatement(q, id, { from: body.from, latest: LINES_TO_SEND });
      await q.query("select gs_record_statement($1, $2, $3, $4::date, $5::jsonb, $6)", [
        body.id,
        id,
        auth.user.id,
        body.from ?? null,
        JSON.stringify(made),
        statementText(made),
      ]);
      return { status: 201, body: await record(q, body.id) };
    });
  });

  app.get("/customers/:id/statements", { config: { access: "signed_in" } }, async (request): Promise<{ items: StatementRecord[] }> => {
    const { id } = parse(IdParams, request.params);
    const rows = await read(ctx, (q) => q.query(`${RECORDS} where s.customer_id = $1 order by s.as_of desc, s.id limit 30`, [id]));
    return { items: rows.map(toRecord) };
  });

  app.get("/statements", { config: { access: "signed_in" } }, async (): Promise<{ items: StatementListItem[] }> => {
    const rows = await read(ctx, (q) =>
      q.query(
        `select customer_id, display_name, phone, balance_usd_cents, credit_limit_usd_cents, over_limit,
                last_statement_id, last_sent_at, last_sent_balance_usd_cents, due
         from statement_list order by due desc, balance_usd_cents desc, customer_id`,
      ),
    );
    return { items: rows.map((row) => camel<StatementListItem>(row, { display_name: "customerName" })) };
  });

  app.get("/statements/:id", { config: { access: "signed_in" } }, async (request): Promise<StatementRecord> => {
    const { id } = parse(IdParams, request.params);
    return read(ctx, (q) => record(q, id));
  });

  app.get("/statements/:id/image", { config: { access: "signed_in" } }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const made = await read(ctx, (q) => snapshot(q, id));
    const png = await ctx.renderer.image(statementHtml(made));
    return reply
      .type("image/png")
      .header("content-disposition", `inline; filename="green-star-statement-${made.asOf.slice(0, 10)}.png"`)
      .header("cache-control", "private, max-age=3600")
      .send(png);
  });

  app.get("/statements/:id/pdf", { config: { access: "signed_in" } }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const made = await read(ctx, (q) => snapshot(q, id));
    const pdf = await ctx.renderer.pdf(statementHtml(made));
    return reply
      .type("application/pdf")
      .header("content-disposition", `inline; filename="green-star-statement-${made.asOf.slice(0, 10)}.pdf"`)
      .header("cache-control", "private, max-age=3600")
      .send(pdf);
  });

  app.post("/statements/:id/sent", { config: { access: "signed_in" } }, async (request, reply): Promise<StatementRecord> => {
    const { id } = parse(IdParams, request.params);
    return write(ctx, request, reply, async ({ q, auth }) => {
      await q.query("select gs_mark_statement_sent($1, $2)", [id, auth.user.id]);
      return { body: await record(q, id) };
    });
  });
}
