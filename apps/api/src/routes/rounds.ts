// Rounds: the driver goes out with goods from any files and comes back with
// cash, receipts and photos. The CEO enters what happened.
//
//   GET    /v1/drivers                          CEO, owner  Drivers
//   POST   /v1/drivers                          CEO         Add a driver
//   PATCH  /v1/drivers/:id                      CEO         Rename, switch off
//   GET    /v1/carriers                         CEO, owner  Our cars and transport offices
//   POST   /v1/carriers                         CEO         Add a carrier
//   PATCH  /v1/carriers/:id                     CEO         Rename, switch off
//   GET    /v1/rounds                           CEO, owner  Rounds, newest first
//   POST   /v1/rounds                           CEO         New round: driver or carrier, consignments from any files, carton counts
//   GET    /v1/rounds/:id                       CEO, owner  Stops, outcomes, money expected
//   POST   /v1/rounds/:id/stops                 CEO         Put a consignment on the round
//   DELETE /v1/rounds/:id/stops/:consignmentId  CEO         Take it off again
//   POST   /v1/rounds/:id/depart                CEO         The driver leaves
//   PUT    /v1/rounds/:id/results               CEO         Outcome, amount, currency and method per customer
//   POST   /v1/round-results/:id/void           CEO         Take a result back
//   POST   /v1/rounds/:id/hand-in               CEO         Cash counted by denomination per currency
//   POST   /v1/hand-ins/:id/void                CEO         Take a hand-in back
//   POST   /v1/exceptions                       CEO         Allow a pay-first handover without full payment, with a reason

import {
  AddStopRequest,
  CEO_ONLY,
  DepartRequest,
  HandInRequest,
  IdParams,
  NewCarrierRequest,
  NewDriverRequest,
  NewExceptionRequest,
  NewRoundRequest,
  READERS,
  RoundQuery,
  RoundResultsRequest,
  StopParams,
  UpdateCarrierRequest,
  UpdateDriverRequest,
  VoidRequest,
  type Carrier,
  type Driver,
  type HandIn,
  type Page,
  type RoundCash,
  type RoundDetail,
  type RoundStop,
  type RoundSummary,
} from "@green-star/contracts";
import { normalizePhone } from "@green-star/domain";
import type { FastifyInstance } from "fastify";
import type { Queryable, Row } from "../db.ts";
import { ApiError, notFound, parse } from "../errors.ts";
import { camel, happened, pager, read, write } from "../http.ts";

const toRound = (row: Row): RoundSummary => camel<RoundSummary>(row, { round_id: "id" });

function driverPhone(typed: string | null | undefined): string | null | undefined {
  if (typed === undefined || typed === null) return typed;
  const phone = normalizePhone(typed);
  if (phone === null) {
    throw new ApiError(400, "invalid_request", "phone: That is not a phone number", { fields: { phone: "That is not a phone number" } });
  }
  return phone;
}

export async function roundDetail(q: Queryable, id: string): Promise<RoundDetail> {
  const summary = await q.first(
    `select o.*, r.note, r.created_at from round_overview o join rounds r on r.id = o.round_id where o.round_id = $1`,
    [id],
  );
  if (summary === undefined) throw notFound("That round");
  const stops = await q.query(
    `select d.stop_id, d.consignment_id, d.customer_id, d.customer_name, d.trust, d.shipment_id, d.shipment_code, d.city,
            d.consignment_status, d.cartons_expected, d.cartons_received, d.amount_due_usd_cents, d.remaining_usd_cents,
            d.result_id, d.outcome, d.received_amount, d.received_currency, d.method, d.iqd_per_100_usd,
            d.credited_usd_cents, d.happened_at, d.has_payment_receipt, d.has_received_receipt, d.has_carton_photo, d.has_exception,
            exists (select 1 from missed_collections m where m.round_id = d.round_id and m.consignment_id = d.consignment_id) as missed_collection
     from round_stop_details d where d.round_id = $1 order by d.seq`,
    [id],
  );
  const cash = await q.query("select currency, collected, handed_in, gap from round_cash where round_id = $1 order by currency", [id]);
  const handIns = await q.query<{ id: string; happened_at: Date; note: string | null; voided: boolean; void_reason: string | null }>(
    `select id, happened_at, note, voided_at is not null as voided, void_reason
     from round_hand_ins where round_id = $1 order by created_at`,
    [id],
  );
  const counts = await q.query<{ round_hand_in_id: string; currency: "USD" | "IQD"; notes: Record<string, number>; counted: number; expected: number; difference: number }>(
    `select c.round_hand_in_id, c.currency, c.notes, c.counted, c.expected, c.difference
     from cash_counts c join round_hand_ins h on h.id = c.round_hand_in_id
     where h.round_id = $1 order by c.currency`,
    [id],
  );
  return {
    ...toRound(summary),
    note: (summary.note as string | null) ?? null,
    createdAt: (summary.created_at as Date).toISOString(),
    stopList: stops.map((row) => camel<RoundStop>(row, { iqd_per_100_usd: "iqdPer100Usd" })),
    cash: cash.map((row) => camel<RoundCash>(row)),
    handIns: handIns.map(
      (h): HandIn => ({
        id: h.id,
        happenedAt: h.happened_at.toISOString(),
        note: h.note,
        voided: h.voided,
        voidReason: h.void_reason,
        counts: counts
          .filter((c) => c.round_hand_in_id === h.id)
          .map((c) => ({ currency: c.currency, notes: c.notes, counted: c.counted, expected: c.expected, difference: c.difference })),
      }),
    ),
  };
}

export async function roundRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  // -- Who carries the goods ------------------------------------------------

  app.get("/drivers", { config: { access: READERS } }, async (): Promise<{ items: Driver[] }> => {
    const rows = await read(ctx, (q) => q.query("select id, name, phone, active from drivers order by active desc, name, id"));
    return { items: rows.map((row) => camel<Driver>(row)) };
  });

  app.post("/drivers", { config: { access: CEO_ONLY } }, async (request, reply): Promise<Driver> => {
    const body = parse(NewDriverRequest, request.body);
    const phone = driverPhone(body.phone) ?? null;
    return write(ctx, request, reply, async ({ q }) => {
      const row = await q.first("insert into drivers (name, phone) values ($1, $2) returning id, name, phone, active", [body.name, phone]);
      return { status: 201, body: camel<Driver>(row as Row) };
    });
  });

  app.patch("/drivers/:id", { config: { access: CEO_ONLY } }, async (request, reply): Promise<Driver> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(UpdateDriverRequest, request.body);
    const phone = driverPhone(body.phone);
    return write(ctx, request, reply, async ({ q }) => {
      const row = await q.first(
        `update drivers set name = coalesce($2, name),
                            phone = case when $3 then $4 else phone end,
                            active = coalesce($5, active)
         where id = $1 returning id, name, phone, active`,
        [id, body.name ?? null, phone !== undefined, phone ?? null, body.active ?? null],
      );
      if (row === undefined) throw notFound("That driver");
      return { body: camel<Driver>(row) };
    });
  });

  app.get("/carriers", { config: { access: READERS } }, async (): Promise<{ items: Carrier[] }> => {
    const rows = await read(ctx, (q) => q.query("select id, name, city, kind, active from carriers order by active desc, name, id"));
    return { items: rows.map((row) => camel<Carrier>(row)) };
  });

  app.post("/carriers", { config: { access: CEO_ONLY } }, async (request, reply): Promise<Carrier> => {
    const body = parse(NewCarrierRequest, request.body);
    return write(ctx, request, reply, async ({ q }) => {
      const row = await q.first("insert into carriers (name, city, kind) values ($1, $2, $3) returning id, name, city, kind, active", [
        body.name,
        body.city ?? null,
        body.kind,
      ]);
      return { status: 201, body: camel<Carrier>(row as Row) };
    });
  });

  app.patch("/carriers/:id", { config: { access: CEO_ONLY } }, async (request, reply): Promise<Carrier> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(UpdateCarrierRequest, request.body);
    return write(ctx, request, reply, async ({ q }) => {
      const row = await q.first(
        `update carriers set name = coalesce($2, name),
                             city = case when $3 then $4 else city end,
                             active = coalesce($5, active)
         where id = $1 returning id, name, city, kind, active`,
        [id, body.name ?? null, body.city !== undefined, body.city ?? null, body.active ?? null],
      );
      if (row === undefined) throw notFound("That carrier");
      return { body: camel<Carrier>(row) };
    });
  });

  // -- Rounds ---------------------------------------------------------------

  app.get("/rounds", { config: { access: READERS } }, async (request): Promise<Page<RoundSummary>> => {
    const query = parse(RoundQuery, request.query);
    const p = pager(query, "r.created_at", "r.id::text");
    const params: unknown[] = [];
    let where = "";
    if (query.status !== undefined) {
      params.push(query.status);
      where = ` and o.status = $${params.length}::round_status`;
    }
    const rows = await read(ctx, (q) =>
      q.query(
        `select o.*, ${p.columns} from round_overview o join rounds r on r.id = o.round_id
         where true ${where} ${p.where(params)} ${p.orderAndLimit(params)}`,
        params,
      ),
    );
    return p.page(rows, toRound);
  });

  app.post("/rounds", { config: { access: CEO_ONLY } }, async (request, reply): Promise<RoundDetail> => {
    const body = parse(NewRoundRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      const id = await q.value<string>(
        `insert into rounds (id, driver_id, carrier_id, note, created_by)
         values (coalesce($1, gen_random_uuid()), $2, $3, $4, $5) returning id`,
        [body.id ?? null, body.driverId ?? null, body.carrierId ?? null, body.note ?? null, auth.user.id],
      );
      for (const stop of body.stops) {
        await q.query("select gs_add_round_stop($1, $2, $3, $4)", [id, stop.consignmentId, auth.user.id, stop.cartonsCounted ?? null]);
      }
      return { status: 201, body: await roundDetail(q, id) };
    });
  });

  app.get("/rounds/:id", { config: { access: READERS } }, async (request): Promise<RoundDetail> => {
    const { id } = parse(IdParams, request.params);
    return read(ctx, (q) => roundDetail(q, id));
  });

  app.post("/rounds/:id/stops", { config: { access: CEO_ONLY } }, async (request, reply): Promise<RoundDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(AddStopRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      await q.query("select gs_add_round_stop($1, $2, $3, $4)", [id, body.consignmentId, auth.user.id, body.cartonsCounted ?? null]);
      return { status: 201, body: await roundDetail(q, id) };
    });
  });

  app.delete("/rounds/:id/stops/:consignmentId", { config: { access: CEO_ONLY } }, async (request, reply): Promise<RoundDetail> => {
    const { id, consignmentId } = parse(StopParams, request.params);
    return write(ctx, request, reply, async ({ q, auth }) => {
      await q.query("select gs_remove_round_stop($1, $2, $3)", [id, consignmentId, auth.user.id]);
      return { body: await roundDetail(q, id) };
    });
  });

  app.post("/rounds/:id/depart", { config: { access: CEO_ONLY } }, async (request, reply): Promise<RoundDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(DepartRequest, request.body ?? {});
    const at = happened(body.at, "at");
    return write(ctx, request, reply, async ({ q, auth }) => {
      await q.query("select gs_round_depart($1, $2, $3)", [id, auth.user.id, at]);
      return { body: await roundDetail(q, id) };
    });
  });

  app.put("/rounds/:id/results", { config: { access: CEO_ONLY } }, async (request, reply): Promise<RoundDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(RoundResultsRequest, request.body);
    const rows = body.results.map((row, index) => ({ ...row, at: happened(row.happenedAt, `results.${index}.happenedAt`) }));
    return write(ctx, request, reply, async ({ q, auth }) => {
      // One transaction: every row is saved or none is.
      for (const row of rows) {
        await q.query("select gs_enter_round_result($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)", [
          row.id,
          id,
          row.consignmentId,
          row.outcome,
          auth.user.id,
          row.at,
          row.received?.amount ?? null,
          row.received?.currency ?? null,
          row.method ?? null,
          row.note ?? null,
        ]);
      }
      return { body: await roundDetail(q, id) };
    });
  });

  app.post("/round-results/:id/void", { config: { access: CEO_ONLY } }, async (request, reply): Promise<RoundDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(VoidRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      const result = await q.first<{ round_id: string }>("select round_id from round_results where id = $1", [id]);
      if (result === undefined) throw notFound("That result");
      await q.query("select gs_void_round_result($1, $2, $3)", [id, auth.user.id, body.reason]);
      return { body: await roundDetail(q, result.round_id) };
    });
  });

  app.post("/rounds/:id/hand-in", { config: { access: CEO_ONLY } }, async (request, reply): Promise<RoundDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(HandInRequest, request.body);
    const at = happened(body.happenedAt);
    return write(ctx, request, reply, async ({ q, auth }) => {
      await q.query("select gs_hand_in_round($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)", [
        body.id,
        id,
        auth.user.id,
        at,
        body.usdNotes === undefined ? null : JSON.stringify(body.usdNotes),
        body.iqdNotes === undefined ? null : JSON.stringify(body.iqdNotes),
        body.note ?? null,
      ]);
      return { status: 201, body: await roundDetail(q, id) };
    });
  });

  app.post("/hand-ins/:id/void", { config: { access: CEO_ONLY } }, async (request, reply): Promise<RoundDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(VoidRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      const handIn = await q.first<{ round_id: string }>("select round_id from round_hand_ins where id = $1", [id]);
      if (handIn === undefined) throw notFound("That hand-in");
      await q.query("select gs_void_hand_in($1, $2, $3)", [id, auth.user.id, body.reason]);
      return { body: await roundDetail(q, handIn.round_id) };
    });
  });

  app.post("/exceptions", { config: { access: CEO_ONLY } }, async (request, reply) => {
    const body = parse(NewExceptionRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      const consignment = await q.first("select 1 from consignments where id = $1", [body.consignmentId]);
      if (consignment === undefined) throw notFound("That consignment");
      const row = await q.first<{ id: string; consignment_id: string; reason: string; created_at: Date }>(
        "insert into exceptions (consignment_id, approved_by, reason) values ($1, $2, $3) returning id, consignment_id, reason, created_at",
        [body.consignmentId, auth.user.id, body.reason],
      );
      return { status: 201, body: camel<{ id: string; consignmentId: string; reason: string; createdAt: string }>(row as Row) };
    });
  });
}
