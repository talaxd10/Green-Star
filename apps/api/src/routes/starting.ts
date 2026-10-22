// Starting balances: what stood on the day the system started.
//
//   GET /v1/starting-balances                 The vault, China, and every customer's
//   PUT /v1/starting-balances/customers/:id   What he owed before, or the credit he had
//   PUT /v1/starting-balances/office          The vault's cash, or what is owed to China
//
// The database does the work (gs_set_starting_balance): typing one again
// takes the old one back and posts the new one, and 0 clears it.

import { CustomerStartRequest, IdParams, OfficeStartRequest, type CustomerStart, type StartingBalances } from "@green-star/contracts";
import type { FastifyInstance } from "fastify";
import type { Queryable, Row } from "../db.ts";
import { notFound, parse } from "../errors.ts";
import { read, write } from "../http.ts";

async function startingBalances(q: Queryable): Promise<StartingBalances> {
  const office = await q.query<Row>(
    `select account_code, amount from starting_balances where account_code in ('vault_usd', 'vault_iqd', 'china_payable')`,
  );
  const of = (code: string) => {
    const row = office.find((r) => r.account_code === code);
    return row === undefined ? null : Math.abs(Number(row.amount));
  };
  const customers = await q.query<Row>(
    `select sb.customer_id, cu.display_name as customer_name, sb.amount, sb.happened_at,
            coalesce(b.balance_usd_cents, 0) as balance_usd_cents
     from starting_balances sb
     join customers cu on cu.id = sb.customer_id
     left join customer_balances b on b.customer_id = sb.customer_id
     where sb.account_kind = 'customer'
     order by lower(cu.display_name), sb.customer_id`,
  );
  return {
    vaultUsdCents: of("vault_usd"),
    vaultIqd: of("vault_iqd"),
    chinaUsdCents: of("china_payable"),
    customers: customers.map(
      (row): CustomerStart => ({
        customerId: row.customer_id as string,
        customerName: row.customer_name as string,
        usdCents: Number(row.amount),
        balanceUsdCents: Number(row.balance_usd_cents),
        setAt: new Date(row.happened_at as string).toISOString(),
      }),
    ),
  };
}

export async function startingRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.get("/starting-balances", { config: { access: "signed_in" } }, async (): Promise<StartingBalances> => read(ctx, startingBalances));

  app.put("/starting-balances/customers/:id", { config: { access: "signed_in" } }, async (request, reply): Promise<StartingBalances> => {
    const { id } = parse(IdParams, request.params);
    const body = parse(CustomerStartRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      const customer = await q.first("select 1 from customers where id = $1 and merged_into is null", [id]);
      if (customer === undefined) throw notFound("That customer");
      await q.query("select gs_set_starting_balance($1, $2, 'customer', $3, $4)", [body.id, auth.user.id, body.usdCents, id]);
      return { status: 200, body: await startingBalances(q) };
    });
  });

  app.put("/starting-balances/office", { config: { access: "signed_in" } }, async (request, reply): Promise<StartingBalances> => {
    const body = parse(OfficeStartRequest, request.body);
    return write(ctx, request, reply, async ({ q, auth }) => {
      await q.query("select gs_set_starting_balance($1, $2, $3, $4)", [body.id, auth.user.id, body.what, body.amount]);
      return { status: 200, body: await startingBalances(q) };
    });
  });
}
