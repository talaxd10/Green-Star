// Customers.
//
//   GET    /v1/customers                     Search by phone, mark or name; filter trusted, over limit, owing
//   POST   /v1/customers                     Create a customer or an agent company
//   GET    /v1/customers/:id                 One customer: balance, phones, marks, trust history
//   PATCH  /v1/customers/:id                 Name and kind; trust and limit, with who asked
//   POST   /v1/customers/:id/phones          Add a phone
//   DELETE /v1/customers/:id/phones/:childId Remove a phone
//   POST   /v1/customers/:id/marks           Add a mark or a mark prefix
//   DELETE /v1/customers/:id/marks/:childId  Remove a mark
//   POST   /v1/customers/:id/merge           Merge a duplicate into this customer

import {
  CustomerChildParams,
  CustomerQuery,
  IdParams,
  MergeCustomerRequest,
  NewCustomerRequest,
  NewMark,
  NewPhone,
  UpdateCustomerRequest,
  type CustomerDetail,
  type CustomerMark,
  type CustomerPhone,
  type CustomerSummary,
  type Page,
  type TrustChange,
} from "@green-star/contracts";
import { normalizeMark, normalizePhone } from "@green-star/domain";
import type { FastifyInstance } from "fastify";
import type { Queryable, Row } from "../db.ts";
import { ApiError, notFound, parse } from "../errors.ts";
import { camel, pager, read, write } from "../http.ts";

const RENAME = { customer_id: "id", display_name: "name" };

const toSummary = (row: Row): CustomerSummary => camel<CustomerSummary>(row, RENAME);

function phoneOf(typed: string, field: string): string {
  const phone = normalizePhone(typed);
  if (phone === null) {
    throw new ApiError(400, "invalid_request", `${field}: That is not a phone number`, { fields: { [field]: "That is not a phone number" } });
  }
  return phone;
}

function markOf(typed: string, field: string): string {
  const mark = normalizeMark(typed);
  if (mark.length === 0) {
    throw new ApiError(400, "invalid_request", `${field}: Enter a mark`, { fields: { [field]: "Enter a mark" } });
  }
  return mark;
}

export async function customerDetail(q: Queryable, id: string): Promise<CustomerDetail> {
  const summary = await q.first("select * from customer_overview where customer_id = $1", [id]);
  if (summary === undefined) {
    // A duplicate that was merged away still answers, to say where it went.
    const merged = await q.first<{ merged_into: string | null; display_name: string }>(
      "select merged_into, display_name from customers where id = $1",
      [id],
    );
    if (merged === undefined || merged.merged_into === null) throw notFound("That customer");
    throw new ApiError(410, "customer_merged", `${merged.display_name} was merged into another customer`, {
      fields: { mergedInto: merged.merged_into },
    });
  }
  const phones = await q.query(
    "select id, phone, is_primary as primary from customer_phones where customer_id = $1 order by is_primary desc, created_at, id",
    [id],
  );
  const marks = await q.query(
    "select id, mark, match, first_seen_on from customer_marks where customer_id = $1 order by mark",
    [id],
  );
  const aliases = await q.query<{ alias: string }>("select alias from customer_aliases where customer_id = $1 order by alias", [id]);
  const changes = await q.query(
    `select t.trust_before, t.trust_after, t.limit_before as limit_before_usd_cents, t.limit_after as limit_after_usd_cents,
            t.asked_by, t.note, u.name as changed_by, t.changed_at
     from customer_trust_changes t join users u on u.id = t.changed_by
     where t.customer_id = $1 order by t.id desc`,
    [id],
  );
  return {
    ...toSummary(summary),
    phoneList: phones.map((row) => camel<CustomerPhone>(row)),
    markList: marks.map((row) => camel<CustomerMark>(row)),
    aliases: aliases.map((row) => row.alias),
    trustChanges: changes.map((row) => camel<TrustChange>(row)),
    mergedInto: null,
  };
}

async function requireCustomer(q: Queryable, id: string): Promise<void> {
  const found = await q.first("select 1 from customers where id = $1 and merged_into is null", [id]);
  if (found === undefined) throw notFound("That customer");
}

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.get("/customers", { config: { access: "signed_in" } }, async (request): Promise<Page<CustomerSummary>> => {
    const query = parse(CustomerQuery, request.query);
    const p = pager(query, "created_at", "customer_id::text");
    const params: unknown[] = [];
    let where = "";

    if (query.q !== undefined && query.q.length > 0) {
      // The same words find him three ways: by phone, by mark, by any part of his name.
      // What was typed is looked for as it is: % and _ are not wildcards.
      const like = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;
      const phone = normalizePhone(query.q);
      const digits = query.q.replace(/\D/g, "");
      const mark = normalizeMark(query.q);
      params.push(like(query.q.toLowerCase()), phone, digits.length >= 4 ? like(digits) : null, like(mark), mark);
      const [name, exact, part, markLike, markText] = [params.length - 4, params.length - 3, params.length - 2, params.length - 1, params.length];
      where += ` and (lower(display_name) like $${name}
                      or exists (select 1 from customer_aliases a where a.customer_id = o.customer_id and lower(a.alias) like $${name})
                      or exists (select 1 from customer_phones ph where ph.customer_id = o.customer_id
                                 and (ph.phone = $${exact} or ph.phone like $${part}))
                      or exists (select 1 from customer_marks m where m.customer_id = o.customer_id
                                 and (m.mark like $${markLike}
                                      or (m.match = 'prefix' and left($${markText}, length(m.mark)) = m.mark))))`;
    }
    if (query.trust !== undefined) {
      params.push(query.trust);
      where += ` and trust = $${params.length}::customer_trust`;
    }
    if (query.filter === "over_limit") where += " and over_limit";
    if (query.filter === "owing") where += " and balance_usd_cents > 0";

    const rows = await read(ctx, (q) =>
      q.query(
        `select o.*, ${p.columns} from customer_overview o where true ${where} ${p.where(params)} ${p.orderAndLimit(params)}`,
        params,
      ),
    );
    return p.page(rows, toSummary);
  });

  app.post("/customers", { config: { access: "signed_in" } }, async (request, reply): Promise<CustomerDetail> => {
    const body = parse(NewCustomerRequest, request.body);
    const phones = body.phones.map((phone, index) => phoneOf(phone, `phones.${index}`));
    const marks = body.marks.map((mark, index) => ({ mark: markOf(mark.mark, `marks.${index}.mark`), match: mark.match }));

    return write(ctx, request, reply, async ({ q }) => {
      const id = await q.value<string>("insert into customers (display_name, kind) values ($1, $2) returning id", [body.name, body.kind]);
      for (const [index, phone] of phones.entries()) {
        await q.query("insert into customer_phones (customer_id, phone, is_primary) values ($1, $2, $3)", [id, phone, index === 0]);
      }
      for (const mark of marks) {
        await q.query("insert into customer_marks (customer_id, mark, match) values ($1, $2, $3)", [id, mark.mark, mark.match]);
      }
      return { status: 201, body: await customerDetail(q, id) };
    });
  });

  app.get("/customers/:id", { config: { access: "signed_in" } }, async (request): Promise<CustomerDetail> => {
    const { id } = parse(IdParams, request.params);
    return read(ctx, (q) => customerDetail(q, id));
  });

  app.patch("/customers/:id", { config: { access: "signed_in" } }, async (request, reply): Promise<CustomerDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(UpdateCustomerRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      await requireCustomer(q, id);
      if (body.name !== undefined || body.kind !== undefined) {
        await q.query("update customers set display_name = coalesce($2, display_name), kind = coalesce($3, kind) where id = $1", [
          id,
          body.name ?? null,
          body.kind ?? null,
        ]);
      }
      if (body.trust !== undefined) {
        await q.query("select gs_set_customer_trust($1, $2, $3, $4, $5, $6)", [
          id,
          body.trust.trust,
          body.trust.trust === "trusted" ? body.trust.creditLimitUsdCents : null,
          auth.user.id,
          body.trust.askedBy,
          body.trust.note ?? null,
        ]);
      }
      return { body: await customerDetail(q, id) };
    });
  });

  app.post("/customers/:id/phones", { config: { access: "signed_in" } }, async (request, reply): Promise<CustomerDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(NewPhone, request.body);
    const phone = phoneOf(body.phone, "phone");
    return write(ctx, request, reply, async ({ q }) => {
      await requireCustomer(q, id);
      if (body.primary) await q.query("update customer_phones set is_primary = false where customer_id = $1 and is_primary", [id]);
      await q.query("insert into customer_phones (customer_id, phone, is_primary) values ($1, $2, $3)", [id, phone, body.primary]);
      return { status: 201, body: await customerDetail(q, id) };
    });
  });

  app.delete("/customers/:id/phones/:childId", { config: { access: "signed_in" } }, async (request, reply): Promise<CustomerDetail> => {
    const { id, childId } = parse(CustomerChildParams, request.params);
    return write(ctx, request, reply, async ({ q }) => {
      await requireCustomer(q, id);
      const gone = await q.query("delete from customer_phones where id = $2 and customer_id = $1 returning id", [id, childId]);
      if (gone.length === 0) throw notFound("That phone");
      return { body: await customerDetail(q, id) };
    });
  });

  app.post("/customers/:id/marks", { config: { access: "signed_in" } }, async (request, reply): Promise<CustomerDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(NewMark, request.body);
    const mark = markOf(body.mark, "mark");
    return write(ctx, request, reply, async ({ q }) => {
      await requireCustomer(q, id);
      await q.query("insert into customer_marks (customer_id, mark, match) values ($1, $2, $3)", [id, mark, body.match]);
      return { status: 201, body: await customerDetail(q, id) };
    });
  });

  app.delete("/customers/:id/marks/:childId", { config: { access: "signed_in" } }, async (request, reply): Promise<CustomerDetail> => {
    const { id, childId } = parse(CustomerChildParams, request.params);
    return write(ctx, request, reply, async ({ q }) => {
      await requireCustomer(q, id);
      const gone = await q.query("delete from customer_marks where id = $2 and customer_id = $1 returning id", [id, childId]);
      if (gone.length === 0) throw notFound("That mark");
      return { body: await customerDetail(q, id) };
    });
  });

  app.post("/customers/:id/merge", { config: { access: "signed_in" } }, async (request, reply): Promise<CustomerDetail> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(MergeCustomerRequest, request.body);
    return write(ctx, request, reply, async ({ q }) => {
      await q.query("select gs_merge_customer($1, $2)", [body.duplicateId, id]);
      return { body: await customerDetail(q, id) };
    });
  });
}
