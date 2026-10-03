-- Statements: what a customer owes and how it came about, in a form the CEO
-- can send him.
--
-- What the database guarantees here:
--   1. A statement is read from the ledger and nowhere else: the lines on the
--      customer's account, in the order they happened, each with the balance
--      after it.
--   2. A mistake and its reversal are left off a statement together, never
--      one without the other, so what is left always adds up to the balance.
--   3. A statement made to send is kept exactly as it was drawn, with the
--      balance the ledger had at that moment. One whose balance is not the
--      ledger's is refused.
--   4. It is marked as sent once, by the CEO. Nothing else about it changes,
--      and it is never deleted.

-- ---------------------------------------------------------------------------
-- A customer's account, line by line
-- ---------------------------------------------------------------------------

-- Every line the ledger has on a customer's account. A charge says which file
-- it is for; a payment says how it was paid and what was handed over. A
-- reversal carries the details of the entry it takes back.
create view customer_account_lines as
select a.customer_id,
       l.id as line_id,
       e.id as entry_id,
       coalesce(o.kind, e.kind) as what,          -- file_confirmed, driver_collected, office_payment, wallet_payment
       e.reverses_id is not null as is_reversal,
       (e.reverses_id is not null
        or exists (select 1 from journal_entries r where r.reverses_id = e.id)) as is_correction,
       e.happened_at,
       e.created_at,
       (e.happened_at at time zone 'Asia/Baghdad')::date as day,
       l.amount as change_usd_cents,               -- positive: he owes more
       e.reason,
       c.id as consignment_id,
       s.id as shipment_id,
       s.code as shipment_code,
       p.method,
       p.received_amount,
       p.received_currency,
       p.iqd_per_100_usd,
       coalesce(p.round_id, (select rr.round_id from round_results rr where rr.payment_entry_id = p.entry_id)) as round_id
from journal_lines l
join accounts a on a.id = l.account_id and a.kind = 'customer'
join journal_entries e on e.id = l.entry_id
left join journal_entries o on o.id = e.reverses_id
left join consignments c on c.charge_entry_id = coalesce(e.reverses_id, e.id)
left join shipments s on s.id = c.shipment_id
left join payments p on p.entry_id = coalesce(e.reverses_id, e.id);

-- One customer's statement: his lines in the order they happened, each with
-- the balance after it. Unless p_corrections is true, an entry that was
-- reversed and its reversal are both left out. They cancel each other, so
-- the last balance is the same either way.
create function gs_customer_statement(p_customer_id uuid, p_corrections boolean default false)
returns table (
  line_no bigint, line_id bigint, entry_id uuid, what entry_kind, is_reversal boolean, is_correction boolean,
  happened_at timestamptz, day date, change_usd_cents bigint, balance_after_usd_cents bigint, reason text,
  consignment_id uuid, shipment_id uuid, shipment_code text,
  method payment_method, received_amount bigint, received_currency currency, iqd_per_100_usd integer, round_id uuid)
language sql stable as $$
  select row_number() over w,
         x.line_id, x.entry_id, x.what, x.is_reversal, x.is_correction, x.happened_at, x.day,
         x.change_usd_cents,
         (sum(x.change_usd_cents) over w)::bigint,
         x.reason, x.consignment_id, x.shipment_id, x.shipment_code,
         x.method, x.received_amount::bigint, x.received_currency, x.iqd_per_100_usd, x.round_id
  from customer_account_lines x
  where x.customer_id = p_customer_id
    and (p_corrections or not x.is_correction)
  window w as (order by x.happened_at, x.created_at, x.line_id);
$$;

-- ---------------------------------------------------------------------------
-- Statements made to send
-- ---------------------------------------------------------------------------

create table statements (
  id                uuid primary key,           -- sent by the caller; the same id twice is one statement
  customer_id       uuid not null references customers (id),
  as_of             timestamptz not null default now(),
  from_day          date,                       -- lines before this day are summed into an opening balance
  balance_usd_cents bigint not null,            -- what the ledger said he owed at that moment
  snapshot          jsonb not null,             -- exactly what was drawn
  summary           text not null,              -- the text to paste into a message
  created_by        uuid not null references users (id),
  created_at        timestamptz not null default now(),
  sent_at           timestamptz,
  sent_by           uuid references users (id),
  constraint statements_summary_not_blank check (length(btrim(summary)) > 0),
  constraint statements_sent_fields check ((sent_at is null) = (sent_by is null))
);

create index statements_customer on statements (customer_id, as_of);

-- A statement stays as it was made. Being sent is the one thing that can
-- happen to it, once.
create function gs_statements_guard() returns trigger
language plpgsql as $$
begin
  if (new.id, new.customer_id, new.as_of, new.from_day, new.balance_usd_cents, new.snapshot, new.summary, new.created_by, new.created_at)
     is distinct from
     (old.id, old.customer_id, old.as_of, old.from_day, old.balance_usd_cents, old.snapshot, old.summary, old.created_by, old.created_at) then
    raise exception 'statement_locked: a statement stays as it was made' using errcode = 'P0001';
  end if;
  if old.sent_at is not null and (new.sent_at, new.sent_by) is distinct from (old.sent_at, old.sent_by) then
    raise exception 'statement_locked: a statement is marked as sent once' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger statements_guard before update on statements
  for each row execute function gs_statements_guard();
create trigger statements_no_delete before delete on statements
  for each row execute function gs_forbid_change();
create trigger statements_no_truncate before truncate on statements
  for each statement execute function gs_forbid_change();
create trigger statements_named before insert or update on statements
  for each row execute function gs_named_by_the_actor('created_by', 'sent_by');

-- Keeps a statement as it was drawn. The snapshot must say the balance the
-- ledger has right now: the customer is locked first, so no payment can land
-- between working the statement out and keeping it.
create function gs_record_statement(
  p_id          uuid,
  p_customer_id uuid,
  p_user        uuid,
  p_from_day    date,
  p_snapshot    jsonb,
  p_summary     text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing statements%rowtype;
  v_balance  bigint;
begin
  if p_id is null then
    raise exception 'statement_id_required' using errcode = 'P0001';
  end if;
  perform gs_lock_customer(p_customer_id);
  select * into v_existing from statements where id = p_id;
  if found then
    if v_existing.customer_id <> p_customer_id then
      raise exception 'statement_id_reused: this id belongs to another customer''s statement' using errcode = 'P0001';
    end if;
    return p_id;   -- the same request again
  end if;
  if not exists (select 1 from customers where id = p_customer_id and merged_into is null) then
    raise exception 'customer_not_found: %', p_customer_id using errcode = 'P0001';
  end if;

  select coalesce((select balance_usd_cents from customer_balances where customer_id = p_customer_id), 0) into v_balance;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object'
     or (p_snapshot ->> 'balanceUsdCents') is null
     or (p_snapshot ->> 'balanceUsdCents')::bigint <> v_balance then
    raise exception 'statement_stale: the account changed while the statement was being made. Make it again.'
      using errcode = 'P0001';
  end if;

  insert into statements (id, customer_id, from_day, balance_usd_cents, snapshot, summary, created_by)
  values (p_id, p_customer_id, p_from_day, v_balance, p_snapshot, p_summary, p_user);
  return p_id;
end $$;

-- The CEO sent it. Once.
create function gs_mark_statement_sent(p_statement_id uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_statement statements%rowtype;
begin
  select * into v_statement from statements where id = p_statement_id for update;
  if not found then
    raise exception 'statement_not_found: %', p_statement_id using errcode = 'P0001';
  end if;
  if v_statement.sent_at is not null then
    return;   -- the same request again
  end if;
  update statements set sent_at = now(), sent_by = p_user where id = p_statement_id;
end $$;

-- Who to send a statement to: trusted customers who owe something, with the
-- last one they were sent. `due` is true when that was a week ago or more,
-- or never.
create view statement_list as
select o.customer_id,
       o.display_name,
       o.phone,
       o.balance_usd_cents,
       o.credit_limit_usd_cents,
       o.over_limit,
       ls.id as last_statement_id,
       ls.sent_at as last_sent_at,
       ls.balance_usd_cents as last_sent_balance_usd_cents,
       (ls.sent_at is null or ls.sent_at <= now() - interval '7 days') as due
from customer_overview o
left join lateral (
  select s.id, s.sent_at, s.balance_usd_cents
  from statements s
  where s.customer_id = o.customer_id and s.sent_at is not null
  order by s.sent_at desc, s.id limit 1
) ls on true
where o.trust = 'trusted' and o.balance_usd_cents > 0;

-- ---------------------------------------------------------------------------
-- The application's role
-- ---------------------------------------------------------------------------

grant select on customer_account_lines, statements, statement_list to green_star_app;
