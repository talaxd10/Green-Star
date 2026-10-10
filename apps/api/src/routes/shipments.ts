// Files from China, their consignments, and problems with the goods.
//
//   GET   /v1/shipments                  Files by status
//   POST  /v1/shipments                  Type a file in by hand, as a draft
//   GET   /v1/shipments/:id              Consignments, expected vs collected, what blocks closing
//   PUT   /v1/shipments/:id              Replace a draft's rows
//   POST  /v1/shipments/:id/confirm      Post every charge in one transaction
//   GET   /v1/consignments               Consignments of a customer, or ready for a round
//   POST  /v1/consignments/:id/cancel    Cancel one and reverse its charge
//   POST  /v1/consignments/:id/correct   Replace one with the right amount
//   GET   /v1/disputes                   Problems with goods, and which wait on China
//   POST  /v1/disputes                   Open a dispute and mark it sent to China
//   PATCH /v1/disputes/:id               Record China's answer and close it
//
// The Excel import is in imports.ts. A file can still be typed in by hand.

import {
  CancelConsignmentRequest,
  ConfirmShipmentRequest,
  CorrectConsignmentRequest,
  DisputeQuery,
  DraftShipmentRequest,
  IdParams,
  NewDisputeRequest,
  ShipmentQuery,
  UpdateDisputeRequest,
  Uuid,
  type Consignment,
  type Dispute,
  type Page,
  type ShipmentDetail,
  type ShipmentSummary,
} from "@green-star/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Queryable, Row } from "../db.ts";
import { ApiError, notFound, parse } from "../errors.ts";
import { camel, happened, pager, read, write } from "../http.ts";

const toShipment = (row: Row): ShipmentSummary => camel<ShipmentSummary>(row, { shipment_id: "id" });
const toConsignment = (row: Row): Consignment => camel<Consignment>(row, { consignment_id: "id" });
const toDispute = (row: Row): Dispute => camel<Dispute>(row);

const DISPUTES = `
  select d.id, d.consignment_id, c.shipment_id, s.code as shipment_code, c.customer_id, cu.display_name as customer_name,
         d.kind, d.note, d.status, d.sent_to_china_at, d.china_answer, d.answered_at, d.created_at
  from disputes d
  join consignments c on c.id = d.consignment_id
  join shipments s on s.id = c.shipment_id
  join customers cu on cu.id = c.customer_id`;

export async function shipmentDetail(q: Queryable, id: string): Promise<ShipmentDetail> {
  const summary = await q.first("select * from shipment_overview where shipment_id = $1", [id]);
  if (summary === undefined) throw notFound("That file");
  const consignments = await q.query(
    "select * from consignment_details where shipment_id = $1 and status <> 'cancelled' order by customer_name, created_at, consignment_id",
    [id],
  );
  const disputes = await q.query(`${DISPUTES} where c.shipment_id = $1 order by d.created_at desc`, [id]);
  const source = await q.first<{ filename: string; rows: string; left_out: string }>(
    `select f.filename, (select count(*) from shipment_lines l where l.shipment_id = s.id) as rows,
            (select count(*) from shipment_lines l where l.shipment_id = s.id and l.consignment_id is null) as left_out
     from shipments s join source_files f on f.id = s.source_file_id where s.id = $1`,
    [id],
  );
  return {
    ...toShipment(summary),
    consignmentList: consignments.map(toConsignment),
    disputes: disputes.map(toDispute),
    sourceFile: source === undefined ? null : { filename: source.filename, rows: Number(source.rows), leftOut: Number(source.left_out) },
  };
}

type DraftRows = z.infer<typeof DraftShipmentRequest>["consignments"];

async function insertConsignments(q: Queryable, shipmentId: string, rows: DraftRows): Promise<void> {
  for (const [index, row] of rows.entries()) {
    const customer = await q.first("select 1 from customers where id = $1 and merged_into is null", [row.customerId]);
    if (customer === undefined) {
      const field = `consignments.${index}.customerId`;
      throw new ApiError(400, "invalid_request", `${field}: There is no such customer`, { fields: { [field]: "There is no such customer" } });
    }
    await q.query(
      `insert into consignments (shipment_id, customer_id, amount_due_usd_cents, other_charges_usd_cents, cartons_expected, city)
       values ($1, $2, $3, $4, $5, $6)`,
      [shipmentId, row.customerId, row.amountDueUsdCents, row.otherChargesUsdCents, row.cartonsExpected ?? null, row.city ?? null],
    );
  }
}

const ConsignmentQuery = z.object({
  customerId: Uuid.optional(),
  /** ready: confirmed and waiting to go on a round, including goods held in the car. unpaid: still owed on. */
  filter: z.enum(["ready", "unpaid"]).optional(),
});

export async function shipmentRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.get("/shipments", { config: { access: "signed_in" } }, async (request): Promise<Page<ShipmentSummary>> => {
    const query = parse(ShipmentQuery, request.query);
    const p = pager(query, "created_at", "shipment_id::text");
    const params: unknown[] = [];
    let where = "";
    if (query.status !== undefined) {
      params.push(query.status);
      where = ` and status = $${params.length}::shipment_status`;
    }
    const rows = await read(ctx, (q) =>
      q.query(`select o.*, ${p.columns} from shipment_overview o where true ${where} ${p.where(params)} ${p.orderAndLimit(params)}`, params),
    );
    return p.page(rows, toShipment);
  });

  app.post("/shipments", { config: { access: "signed_in" } }, async (request, reply): Promise<ShipmentDetail> => {
    const body = parse(DraftShipmentRequest, request.body);
    return write(ctx, request, reply, async ({ q }) => {
      const id = await q.value<string>("insert into shipments (code, arrived_on) values ($1, $2) returning id", [
        body.code,
        body.arrivedOn ?? null,
      ]);
      await insertConsignments(q, id, body.consignments);
      return { status: 201, body: await shipmentDetail(q, id) };
    });
  });

  app.get("/shipments/:id", { config: { access: "signed_in" } }, async (request): Promise<ShipmentDetail> => {
    const { id } = parse(IdParams, request.params);
    return read(ctx, (q) => shipmentDetail(q, id));
  });

  app.put("/shipments/:id", { config: { access: "signed_in" } }, async (request, reply): Promise<ShipmentDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(DraftShipmentRequest, request.body);
    return write(ctx, request, reply, async ({ q }) => {
      const shipment = await q.first<{ status: string }>("select status from shipments where id = $1 for update", [id]);
      if (shipment === undefined) throw notFound("That file");
      if (shipment.status !== "draft") {
        throw new ApiError(422, "shipment_locked", "This file is confirmed. Cancel or correct a consignment instead.");
      }
      await q.query("update shipments set code = $2, arrived_on = $3 where id = $1", [id, body.code, body.arrivedOn ?? null]);
      // An imported file's rows stay with the customer they went to.
      const lines = await q.query<{ id: string; customer_id: string }>(
        "select l.id, c.customer_id from shipment_lines l join consignments c on c.id = l.consignment_id where l.shipment_id = $1",
        [id],
      );
      await q.query("update shipment_lines set consignment_id = null where shipment_id = $1", [id]);
      await q.query("delete from consignments where shipment_id = $1", [id]);
      await insertConsignments(q, id, body.consignments);
      for (const line of lines) {
        await q.query(
          "update shipment_lines set consignment_id = (select c.id from consignments c where c.shipment_id = $2 and c.customer_id = $3) where id = $1",
          [line.id, id, line.customer_id],
        );
      }
      return { body: await shipmentDetail(q, id) };
    });
  });

  app.post("/shipments/:id/confirm", { config: { access: "signed_in" } }, async (request, reply): Promise<ShipmentDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(ConfirmShipmentRequest, request.body ?? {});
    const at = happened(body.confirmedAt, "confirmedAt");
    return write(ctx, request, reply, async ({ q, auth }) => {
      await q.query("select gs_confirm_shipment($1, $2, $3)", [id, auth.user.id, at]);
      return { body: await shipmentDetail(q, id) };
    });
  });

  app.get("/consignments", { config: { access: "signed_in" } }, async (request): Promise<{ items: Consignment[] }> => {
    const query = parse(ConsignmentQuery, request.query);
    const params: unknown[] = [];
    let where = "status <> 'cancelled' and shipment_status <> 'draft'";
    if (query.customerId !== undefined) {
      params.push(query.customerId);
      where += ` and customer_id = $${params.length}`;
    }
    if (query.filter === "ready") where += " and status in ('listed', 'held')";
    if (query.filter === "unpaid") where += " and remaining_usd_cents > 0";
    if (query.customerId === undefined && query.filter === undefined) {
      throw new ApiError(400, "invalid_request", "Ask for a customer's consignments, or the ones ready for a round", {
        fields: { customerId: "Give a customer or a filter" },
      });
    }
    const rows = await read(ctx, (q) =>
      q.query(`select * from consignment_details where ${where} order by confirmed_at, created_at, consignment_id limit 1000`, params),
    );
    return { items: rows.map(toConsignment) };
  });

  app.post("/consignments/:id/cancel", { config: { access: "signed_in" } }, async (request, reply): Promise<ShipmentDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(CancelConsignmentRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      const row = await q.first<{ shipment_id: string }>("select shipment_id from consignments where id = $1", [id]);
      if (row === undefined) throw notFound("That consignment");
      await q.query("select gs_cancel_consignment($1, $2, $3)", [id, auth.user.id, body.reason]);
      return { body: await shipmentDetail(q, row.shipment_id) };
    });
  });

  app.post("/consignments/:id/correct", { config: { access: "signed_in" } }, async (request, reply): Promise<Consignment> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(CorrectConsignmentRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      const replacement = await q.value<string>("select gs_correct_consignment($1, $2, $3, $4, $5)", [
        id,
        body.amountDueUsdCents,
        body.otherChargesUsdCents,
        auth.user.id,
        body.reason,
      ]);
      const row = await q.first("select * from consignment_details where consignment_id = $1", [replacement]);
      if (row === undefined) throw notFound("That consignment");
      return { body: toConsignment(row) };
    });
  });

  app.get("/disputes", { config: { access: "signed_in" } }, async (request): Promise<{ items: Dispute[] }> => {
    const query = parse(DisputeQuery, request.query);
    const params: unknown[] = [];
    let where = "true";
    if (query.status !== undefined) {
      params.push(query.status);
      where += ` and d.status = $${params.length}::dispute_status`;
    }
    if (query.waiting === "true") where += " and d.status in ('open', 'sent_to_china')";
    const rows = await read(ctx, (q) => q.query(`${DISPUTES} where ${where} order by d.created_at desc limit 500`, params));
    return { items: rows.map(toDispute) };
  });

  app.post("/disputes", { config: { access: "signed_in" } }, async (request, reply): Promise<Dispute> => {
    const body = parse(NewDisputeRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      const consignment = await q.first("select 1 from consignments where id = $1 and status <> 'cancelled'", [body.consignmentId]);
      if (consignment === undefined) throw notFound("That consignment");
      const id = await q.value<string>(
        `insert into disputes (consignment_id, kind, note, status, sent_to_china_at, created_by)
         values ($1, $2, $3, $4::dispute_status, case when $4::dispute_status = 'sent_to_china' then now() end, $5) returning id`,
        [body.consignmentId, body.kind, body.note ?? null, body.sentToChina ? "sent_to_china" : "open", auth.user.id],
      );
      const row = await q.first(`${DISPUTES} where d.id = $1`, [id]);
      return { status: 201, body: toDispute(row as Row) };
    });
  });

  app.patch("/disputes/:id", { config: { access: "signed_in" } }, async (request, reply): Promise<Dispute> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(UpdateDisputeRequest, request.body);
    return write(ctx, request, reply, async ({ q }) => {
      const current = await q.first<{ status: string; china_answer: string | null }>(
        "select status, china_answer from disputes where id = $1 for update",
        [id],
      );
      if (current === undefined) throw notFound("That dispute");
      if (current.status === "closed") throw new ApiError(422, "dispute_closed", "This dispute is already closed");

      // open -> sent to China -> answered -> closed. An answer can be recorded and the dispute closed in one go.
      let status = current.status;
      if (body.sentToChina === true && status === "open") status = "sent_to_china";
      if (body.chinaAnswer !== undefined) status = "answered";
      if (body.close === true) {
        if (body.chinaAnswer === undefined && current.china_answer === null) {
          throw new ApiError(422, "answer_missing", "Write what China said before closing the dispute");
        }
        status = "closed";
      }
      await q.query(
        `update disputes
            set status = $2::dispute_status,
                sent_to_china_at = case when $2::dispute_status <> 'open' then coalesce(sent_to_china_at, now()) else sent_to_china_at end,
                china_answer = coalesce($3::text, china_answer),
                answered_at = case when $3::text is not null then now() else answered_at end
          where id = $1`,
        [id, status, body.chinaAnswer ?? null],
      );
      const row = await q.first(`${DISPUTES} where d.id = $1`, [id]);
      return { body: toDispute(row as Row) };
    });
  });
}
