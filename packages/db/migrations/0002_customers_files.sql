-- Customers, files from China, consignments, and which payment paid which
-- consignment.
--
-- One customer on one file is a consignment. Money is charged and paid per
-- consignment; a customer's balance is the sum across all of them, in USD.
--
-- What the database guarantees here:
--   1. A phone number or a shipping mark belongs to one customer.
--   2. The same file (by sha256) is never imported twice.
--   3. A consignment's amount cannot change once its file is confirmed. A
--      wrong amount is fixed by cancelling it (which reverses the charge) and
--      adding a corrected one.
--   4. Confirming a file posts one charge per customer, once.
--   5. Payments are applied to a customer's oldest unpaid consignments first,
--      automatically, every time anything posts to that customer's account.
--   6. Trust and credit limits change only through gs_set_customer_trust,
--      which records who changed it and who asked.
--   7. Every charge in the ledger belongs to a consignment.

create type customer_kind as enum ('person', 'agent_company');
create type customer_trust as enum ('trusted', 'pay_first');
create type mark_match as enum ('exact', 'prefix');
create type shipment_status as enum ('draft', 'confirmed', 'on_rounds', 'reconciling', 'closed');
create type consignment_status as enum (
  'listed', 'on_round',
  'delivered_paid', 'delivered_prepaid', 'delivered_on_account', 'held', 'delivered_not_paid',
  'closed', 'cancelled'
);
create type dispute_kind as enum ('missing', 'damaged', 'weight');
create type dispute_status as enum ('open', 'sent_to_china', 'answered', 'closed');

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------

create table customers (
  id                     uuid primary key default gen_random_uuid(),
  display_name           text not null,
  kind                   customer_kind not null default 'person',
  trust                  customer_trust not null default 'pay_first',
  credit_limit_usd_cents bigint,
  created_at             timestamptz not null default now(),
  constraint customers_name_not_blank check (length(btrim(display_name)) > 0),
  constraint customers_limit_not_negative check (credit_limit_usd_cents is null or credit_limit_usd_cents >= 0),
  constraint customers_limit_only_when_trusted check (trust = 'trusted' or credit_limit_usd_cents is null)
);

alter table accounts
  add constraint accounts_customer_fk foreign key (customer_id) references customers (id);

-- Every change of trust or limit, with who made it and who asked for it.
create table customer_trust_changes (
  id               bigint generated always as identity primary key,
  customer_id      uuid not null references customers (id),
  trust_before     customer_trust not null,
  trust_after      customer_trust not null,
  limit_before     bigint,
  limit_after      bigint,
  changed_by       uuid not null,
  asked_by         text not null,
  note             text,
  changed_at       timestamptz not null default now(),
  constraint customer_trust_changes_asked_by_not_blank check (length(btrim(asked_by)) > 0)
);

create trigger customer_trust_changes_no_change before update or delete on customer_trust_changes
  for each row execute function gs_forbid_change();

-- Phones are stored in international form: +9647701234567.
create table customer_phones (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers (id),
  phone       text not null unique,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint customer_phones_format check (phone ~ '^\+[1-9][0-9]{7,14}$')
);

create unique index customer_phones_one_primary on customer_phones (customer_id) where is_primary;

-- Upper case, single spaces, no leading or trailing space.
create function gs_normalize_mark(p_mark text) returns text
language sql immutable strict as $$
  select regexp_replace(upper(btrim(p_mark)), '\s+', ' ', 'g');
$$;

-- A shipping mark. An agent company whose mark changes on every file is
-- stored as a prefix: YARO matches YARO MHAMAD and YARO OSMAN.
create table customer_marks (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references customers (id),
  mark          text not null unique,
  match         mark_match not null default 'exact',
  first_seen_on date not null default current_date,
  constraint customer_marks_normalized check (mark = gs_normalize_mark(mark) and length(mark) > 0)
);

-- A name exactly as it was written on a file. Learned on every import.
create table customer_aliases (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references customers (id),
  alias         text not null,
  first_seen_on date not null default current_date,
  unique (customer_id, alias),
  constraint customer_aliases_not_blank check (length(btrim(alias)) > 0)
);

-- Finds the customer for a row of a file: by phone, then by exact mark, then
-- by the longest matching prefix. Returns no row when nothing matches, and
-- conflict = true when the phone and the mark point at different customers.
create function gs_match_customer(p_phone text, p_mark text)
returns table (customer_id uuid, matched_by text, conflict boolean)
language plpgsql stable as $$
declare
  v_mark       text := gs_normalize_mark(p_mark);
  v_by_phone   uuid;
  v_by_mark    uuid;
  v_mark_kind  text;
begin
  if p_phone is not null then
    select p.customer_id into v_by_phone from customer_phones p where p.phone = p_phone;
  end if;

  if v_mark is not null and length(v_mark) > 0 then
    select m.customer_id, 'mark' into v_by_mark, v_mark_kind
    from customer_marks m where m.match = 'exact' and m.mark = v_mark;

    if v_by_mark is null then
      select m.customer_id, 'mark_prefix' into v_by_mark, v_mark_kind
      from customer_marks m
      where m.match = 'prefix'
        and (v_mark = m.mark
             or (left(v_mark, length(m.mark)) = m.mark
                 and substr(v_mark, length(m.mark) + 1, 1) !~ '[[:alnum:]]'))
      order by length(m.mark) desc
      limit 1;
    end if;
  end if;

  if v_by_phone is not null then
    return query select v_by_phone, 'phone'::text, (v_by_mark is not null and v_by_mark <> v_by_phone);
  elsif v_by_mark is not null then
    return query select v_by_mark, v_mark_kind, false;
  end if;
end $$;

create function gs_set_customer_trust(
  p_customer_id uuid,
  p_trust       customer_trust,
  p_limit_usd_cents bigint,
  p_changed_by  uuid,
  p_asked_by    text,
  p_note        text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old customers%rowtype;
begin
  select * into v_old from customers where id = p_customer_id for update;
  if not found then
    raise exception 'customer_not_found: %', p_customer_id using errcode = 'P0001';
  end if;
  if p_trust = 'pay_first' and p_limit_usd_cents is not null then
    raise exception 'limit_not_allowed: only a trusted customer has a limit' using errcode = 'P0001';
  end if;
  if v_old.trust = p_trust and v_old.credit_limit_usd_cents is not distinct from p_limit_usd_cents then
    return;
  end if;
  update customers set trust = p_trust, credit_limit_usd_cents = p_limit_usd_cents where id = p_customer_id;
  insert into customer_trust_changes
    (customer_id, trust_before, trust_after, limit_before, limit_after, changed_by, asked_by, note)
  values
    (p_customer_id, v_old.trust, p_trust, v_old.credit_limit_usd_cents, p_limit_usd_cents,
     p_changed_by, p_asked_by, nullif(btrim(p_note), ''));
end $$;

-- ---------------------------------------------------------------------------
-- Files from China
-- ---------------------------------------------------------------------------

create table source_files (
  id          uuid primary key default gen_random_uuid(),
  filename    text not null,
  storage_key text not null,
  sha256      text not null unique,        -- the fingerprint that stops a double import
  batch_id    uuid,                        -- several files dropped at once
  uploaded_by uuid not null,
  uploaded_at timestamptz not null default now(),
  constraint source_files_sha256_format check (sha256 ~ '^[0-9a-f]{64}$')
);

create table shipments (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,     -- e.g. GSSK6926
  source_file_id uuid references source_files (id),
  arrived_on     date,
  status         shipment_status not null default 'draft',
  confirmed_at   timestamptz,
  confirmed_by   uuid,
  created_at     timestamptz not null default now(),
  constraint shipments_code_not_blank check (length(btrim(code)) > 0),
  constraint shipments_confirmed_fields check ((status = 'draft') = (confirmed_at is null))
);

create table consignments (
  id                      uuid primary key default gen_random_uuid(),
  shipment_id             uuid not null references shipments (id),
  customer_id             uuid not null references customers (id),
  amount_due_usd_cents    bigint not null,           -- the file's money to collect; $0 is prepaid
  other_charges_usd_cents bigint not null default 0, -- the part above freight + packing + customs
  trust_at_time           customer_trust not null,
  status                  consignment_status not null default 'listed',
  cartons_expected        integer,
  cartons_received        integer,
  city                    text,
  charge_entry_id         uuid references journal_entries (id),
  created_at              timestamptz not null default now(),
  constraint consignments_amount_not_negative check (amount_due_usd_cents >= 0),
  constraint consignments_other_within_amount check (other_charges_usd_cents between 0 and amount_due_usd_cents),
  constraint consignments_cartons_not_negative check (
    coalesce(cartons_expected, 0) >= 0 and coalesce(cartons_received, 0) >= 0)
);

create unique index consignments_one_per_customer_per_file
  on consignments (shipment_id, customer_id) where status <> 'cancelled';
create unique index consignments_charge_entry on consignments (charge_entry_id) where charge_entry_id is not null;
create index consignments_customer on consignments (customer_id);

-- Rows exactly as China sent them. The money columns are provisional until
-- the real files arrive; raw keeps the whole row whatever the layout.
create table shipment_lines (
  id                      uuid primary key default gen_random_uuid(),
  shipment_id             uuid not null references shipments (id),
  consignment_id          uuid references consignments (id),
  row_no                  integer not null,
  mark                    text,
  cartons                 integer,
  weight_grams            bigint,
  goods_note              text,
  price_per_kg_usd_cents  bigint,
  freight_usd_cents       bigint,
  packing_usd_cents       bigint,
  customs_usd_cents       bigint,
  collect_usd_cents       bigint,
  city                    text,
  note                    text,
  raw                     jsonb not null,
  unique (shipment_id, row_no)
);

create table disputes (
  id               uuid primary key default gen_random_uuid(),
  consignment_id   uuid not null references consignments (id),
  kind             dispute_kind not null,
  note             text,
  status           dispute_status not null default 'open',
  sent_to_china_at timestamptz,
  china_answer     text,
  answered_at      timestamptz,
  created_by       uuid not null,
  created_at       timestamptz not null default now()
);

create index disputes_consignment on disputes (consignment_id);

-- Which payment paid which consignment. Append-only. An allocation stops
-- counting when its payment is reversed or its consignment is cancelled.
create table allocations (
  id               bigint generated always as identity primary key,
  entry_id         uuid not null references journal_entries (id),
  consignment_id   uuid not null references consignments (id),
  amount_usd_cents bigint not null,
  created_at       timestamptz not null default now(),
  constraint allocations_amount_positive check (amount_usd_cents > 0)
);

create index allocations_entry on allocations (entry_id);
create index allocations_consignment on allocations (consignment_id);

create trigger allocations_no_change before update or delete on allocations
  for each row execute function gs_forbid_change();
create trigger allocations_no_truncate before truncate on allocations
  for each statement execute function gs_forbid_change();

-- ---------------------------------------------------------------------------
-- Guards on consignments
-- ---------------------------------------------------------------------------

-- True for the role that owns the schema (migrations and the functions below),
-- false for the application's login.
create function gs_is_owner() returns boolean
language sql stable as $$
  select current_user = (select pg_get_userbyid(c.relowner) from pg_class c
                         where c.relname = 'consignments' and c.relnamespace = 'public'::regnamespace);
$$;

create function gs_consignments_guard() returns trigger
language plpgsql as $$
declare
  v_status shipment_status;
begin
  if tg_op = 'DELETE' then
    select status into v_status from shipments where id = old.shipment_id;
    if v_status <> 'draft' then
      raise exception 'consignment_locked: a consignment on a confirmed file cannot be deleted. Cancel it instead.'
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  select status into v_status from shipments where id = new.shipment_id;

  if tg_op = 'INSERT' then
    if new.trust_at_time is null then
      select trust into new.trust_at_time from customers where id = new.customer_id;
    end if;
    if v_status <> 'draft' and not gs_is_owner() then
      raise exception 'shipment_locked: file is already confirmed. Use gs_correct_consignment.'
        using errcode = 'P0001';
    end if;
    if new.charge_entry_id is not null and not gs_is_owner() then
      raise exception 'consignment_locked: a charge is set only by confirming the file' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if old.status = 'cancelled' and new is distinct from old then
    raise exception 'consignment_locked: a cancelled consignment cannot change' using errcode = 'P0001';
  end if;
  if old.charge_entry_id is not null and new.charge_entry_id is distinct from old.charge_entry_id then
    raise exception 'consignment_locked: the charge on a consignment cannot change' using errcode = 'P0001';
  end if;
  if new.charge_entry_id is distinct from old.charge_entry_id and not gs_is_owner() then
    raise exception 'consignment_locked: a charge is set only by confirming the file' using errcode = 'P0001';
  end if;
  if (new.shipment_id, new.customer_id, new.amount_due_usd_cents, new.other_charges_usd_cents)
     is distinct from
     (old.shipment_id, old.customer_id, old.amount_due_usd_cents, old.other_charges_usd_cents)
     and (v_status <> 'draft' or old.charge_entry_id is not null) then
    raise exception 'consignment_locked: the amount and customer cannot change after the file is confirmed. Use gs_correct_consignment.'
      using errcode = 'P0001';
  end if;
  if new.status = 'cancelled' and old.status <> 'cancelled'
     and old.charge_entry_id is not null
     and not exists (select 1 from journal_entries r where r.reverses_id = old.charge_entry_id) then
    raise exception 'cancel_needs_reversal: use gs_cancel_consignment, which reverses the charge'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger consignments_guard before insert or update or delete on consignments
  for each row execute function gs_consignments_guard();

create function gs_shipment_lines_guard() returns trigger
language plpgsql as $$
declare
  v_status shipment_status;
begin
  select status into v_status from shipments where id = coalesce(new.shipment_id, old.shipment_id);
  if v_status <> 'draft' then
    raise exception 'shipment_locked: the rows of a confirmed file cannot change' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;

create trigger shipment_lines_guard before insert or update or delete on shipment_lines
  for each row execute function gs_shipment_lines_guard();

-- A charge is posted only by confirming a file, and undone only by cancelling
-- the consignment, so every charge in the ledger belongs to a consignment.
create function gs_charge_entries_guard() returns trigger
language plpgsql as $$
begin
  if gs_is_owner() then
    return new;
  end if;
  if new.kind = 'file_confirmed' then
    raise exception 'charge_needs_consignment: a charge is posted by gs_confirm_shipment' using errcode = 'P0001';
  end if;
  if new.reverses_id is not null
     and exists (select 1 from journal_entries e where e.id = new.reverses_id and e.kind = 'file_confirmed') then
    raise exception 'charge_needs_consignment: a charge is reversed by gs_cancel_consignment' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger journal_entries_charge_guard before insert on journal_entries
  for each row execute function gs_charge_entries_guard();

-- ---------------------------------------------------------------------------
-- Reading money per consignment and per payment
-- ---------------------------------------------------------------------------

create view effective_allocations as
select al.id, al.entry_id, al.consignment_id, al.amount_usd_cents, al.created_at
from allocations al
join consignments c on c.id = al.consignment_id
where c.status <> 'cancelled'
  and c.charge_entry_id is not null
  and not exists (select 1 from journal_entries r where r.reverses_id = al.entry_id)
  and not exists (select 1 from journal_entries r where r.reverses_id = c.charge_entry_id);

-- What each consignment is owed and how much of it is paid.
create view consignment_money as
select c.id as consignment_id,
       c.shipment_id,
       c.customer_id,
       c.status,
       d.due_usd_cents,
       coalesce(p.paid, 0) as paid_usd_cents,
       d.due_usd_cents - coalesce(p.paid, 0) as remaining_usd_cents
from consignments c
cross join lateral (
  select case
           when c.status <> 'cancelled'
            and c.charge_entry_id is not null
            and not exists (select 1 from journal_entries r where r.reverses_id = c.charge_entry_id)
           then c.amount_due_usd_cents
           else 0
         end as due_usd_cents
) d
left join lateral (
  select sum(ea.amount_usd_cents) as paid from effective_allocations ea where ea.consignment_id = c.id
) p on true;

-- Every customer payment that still stands, and how much of it is applied.
create view customer_payments as
select e.id as entry_id,
       a.customer_id,
       e.kind,
       e.happened_at,
       e.created_at,
       -sum(l.amount) as credit_usd_cents,
       coalesce((select sum(ea.amount_usd_cents) from effective_allocations ea where ea.entry_id = e.id), 0)
         as allocated_usd_cents
from journal_entries e
join journal_lines l on l.entry_id = e.id
join accounts a on a.id = l.account_id and a.kind = 'customer'
where e.kind in ('driver_collected', 'office_payment', 'wallet_payment')
  and not exists (select 1 from journal_entries r where r.reverses_id = e.id)
group by e.id, a.customer_id, e.kind, e.happened_at, e.created_at;

-- Trusted customers whose balance is above their own limit. There is no
-- overdue alert: a trusted customer has no fixed time to pay.
create view customers_over_limit as
select c.id as customer_id,
       c.display_name,
       c.credit_limit_usd_cents,
       b.balance_usd_cents,
       b.balance_usd_cents - c.credit_limit_usd_cents as over_by_usd_cents
from customers c
join customer_balances b on b.customer_id = c.id
where c.trust = 'trusted'
  and c.credit_limit_usd_cents is not null
  and b.balance_usd_cents > c.credit_limit_usd_cents;

-- ---------------------------------------------------------------------------
-- Allocation: oldest unpaid consignment first
-- ---------------------------------------------------------------------------

create function gs_allocate_customer(p_customer_id uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pay   record;
  v_con   record;
  v_left  bigint;
  v_take  bigint;
  v_count integer := 0;
begin
  -- One allocation run per customer at a time.
  perform pg_advisory_xact_lock(hashtextextended('gs_allocate:' || p_customer_id::text, 0));

  for v_pay in
    select entry_id, credit_usd_cents - allocated_usd_cents as unallocated
    from customer_payments
    where customer_id = p_customer_id and credit_usd_cents > allocated_usd_cents
    order by happened_at, created_at, entry_id
  loop
    v_left := v_pay.unallocated;
    for v_con in
      select cm.consignment_id, cm.remaining_usd_cents
      from consignment_money cm
      join consignments c on c.id = cm.consignment_id
      join shipments s on s.id = c.shipment_id
      where cm.customer_id = p_customer_id and cm.remaining_usd_cents > 0
      order by s.confirmed_at, c.created_at, c.id
    loop
      exit when v_left = 0;
      v_take := least(v_left, v_con.remaining_usd_cents);
      insert into allocations (entry_id, consignment_id, amount_usd_cents)
      values (v_pay.entry_id, v_con.consignment_id, v_take);
      v_left := v_left - v_take;
      v_count := v_count + 1;
    end loop;
    exit when v_left > 0;   -- nothing left to pay; the rest stays as credit
  end loop;
  return v_count;
end $$;

-- Posting anything to a customer's account re-runs allocation for that
-- customer, so payments, charges and reversals can never leave it stale.
create or replace function gs_post_entry(
  p_kind            entry_kind,
  p_happened_at     timestamptz,
  p_created_by      uuid,
  p_idempotency_key text,
  p_lines           jsonb,
  p_reason          text default null,
  p_rate            integer default null,
  p_reverses_id     uuid default null
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'idempotency_key_required' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines_required: lines must be a JSON array' using errcode = 'P0001';
  end if;

  insert into journal_entries (kind, happened_at, created_by, reason, reverses_id, idempotency_key, iqd_per_100_usd)
  values (p_kind, p_happened_at, p_created_by, nullif(btrim(p_reason), ''), p_reverses_id, p_idempotency_key, p_rate)
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from journal_entries where idempotency_key = p_idempotency_key;
    return v_id;
  end if;

  insert into journal_lines (entry_id, account_id, currency, amount)
  select v_id,
         (l ->> 'account_id')::uuid,
         (l ->> 'currency')::currency,
         (l ->> 'amount')::bigint
  from jsonb_array_elements(p_lines) as l;

  -- Run the commit-time checks now, so the caller gets the error here.
  set constraints journal_lines_balanced, journal_entries_complete immediate;
  set constraints journal_lines_balanced, journal_entries_complete deferred;

  perform gs_allocate_customer(t.customer_id)
  from (select distinct a.customer_id
        from journal_lines l join accounts a on a.id = l.account_id
        where l.entry_id = v_id and a.kind = 'customer'
        order by a.customer_id) t;

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Confirming a file, and fixing a consignment afterwards
-- ---------------------------------------------------------------------------

create function gs_charge_consignment(p_consignment_id uuid, p_user uuid, p_happened_at timestamptz)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_con   consignments%rowtype;
  v_entry uuid;
  v_name  text;
begin
  select * into v_con from consignments where id = p_consignment_id for update;
  if v_con.charge_entry_id is not null or v_con.status = 'cancelled' then
    return v_con.charge_entry_id;
  end if;
  update consignments
     set trust_at_time = (select trust from customers where id = v_con.customer_id)
   where id = p_consignment_id;
  if v_con.amount_due_usd_cents = 0 then
    return null;   -- prepaid: posts nothing
  end if;
  select display_name into v_name from customers where id = v_con.customer_id;
  v_entry := gs_post_entry(
    'file_confirmed', p_happened_at, p_user, 'charge:' || p_consignment_id::text,
    jsonb_build_array(
      jsonb_build_object('account_id', gs_customer_account(v_con.customer_id, v_name),
                         'currency', 'USD', 'amount', v_con.amount_due_usd_cents),
      jsonb_build_object('account_id', gs_account('china_payable'),
                         'currency', 'USD', 'amount', -v_con.amount_due_usd_cents)));
  update consignments set charge_entry_id = v_entry where id = p_consignment_id;
  perform gs_allocate_customer(v_con.customer_id);   -- credit already on the account pays it
  return v_entry;
end $$;

revoke all on function gs_charge_consignment(uuid, uuid, timestamptz) from public;

-- Confirms a draft file: one charge per customer, all in one transaction.
-- Calling it again on a confirmed file does nothing.
create function gs_confirm_shipment(p_shipment_id uuid, p_user uuid, p_happened_at timestamptz default now())
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status shipment_status;
  v_con    record;
  v_count  integer := 0;
begin
  select status into v_status from shipments where id = p_shipment_id for update;
  if not found then
    raise exception 'shipment_not_found: %', p_shipment_id using errcode = 'P0001';
  end if;
  if v_status <> 'draft' then
    return 0;
  end if;
  if not exists (select 1 from consignments where shipment_id = p_shipment_id and status <> 'cancelled') then
    raise exception 'shipment_empty: a file with no customers cannot be confirmed' using errcode = 'P0001';
  end if;

  update shipments
     set status = 'confirmed', confirmed_at = p_happened_at, confirmed_by = p_user
   where id = p_shipment_id;

  for v_con in
    select id from consignments
    where shipment_id = p_shipment_id and status <> 'cancelled'
    order by created_at, id
  loop
    perform gs_charge_consignment(v_con.id, p_user, p_happened_at);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Cancels a consignment on a confirmed file by reversing its charge. Money
-- that had been applied to it moves to the customer's other unpaid
-- consignments, or stays on the account as credit.
create function gs_cancel_consignment(p_consignment_id uuid, p_user uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_con consignments%rowtype;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'reason_required: say why the consignment is cancelled' using errcode = 'P0001';
  end if;
  select * into v_con from consignments where id = p_consignment_id for update;
  if not found then
    raise exception 'consignment_not_found: %', p_consignment_id using errcode = 'P0001';
  end if;
  if v_con.status = 'cancelled' then
    return;
  end if;
  if v_con.charge_entry_id is not null
     and not exists (select 1 from journal_entries r where r.reverses_id = v_con.charge_entry_id) then
    perform gs_reverse_entry(v_con.charge_entry_id, p_user, p_reason, 'cancel:' || p_consignment_id::text);
  end if;
  update consignments set status = 'cancelled' where id = p_consignment_id;
  perform gs_allocate_customer(v_con.customer_id);
end $$;

-- Replaces a consignment on a confirmed file with a corrected amount: cancels
-- the old one and charges a new one. Returns the new consignment's id.
create function gs_correct_consignment(
  p_consignment_id          uuid,
  p_amount_due_usd_cents    bigint,
  p_other_charges_usd_cents bigint,
  p_user                    uuid,
  p_reason                  text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old    consignments%rowtype;
  v_status shipment_status;
  v_at     timestamptz;
  v_new    uuid;
begin
  select * into v_old from consignments where id = p_consignment_id for update;
  if not found then
    raise exception 'consignment_not_found: %', p_consignment_id using errcode = 'P0001';
  end if;
  if v_old.status = 'cancelled' then
    raise exception 'consignment_cancelled: % is already cancelled', p_consignment_id using errcode = 'P0001';
  end if;
  select status, confirmed_at into v_status, v_at from shipments where id = v_old.shipment_id;
  if v_status = 'draft' then
    raise exception 'shipment_draft: edit the consignment directly while the file is a draft' using errcode = 'P0001';
  end if;

  perform gs_cancel_consignment(p_consignment_id, p_user, p_reason);

  insert into consignments
    (shipment_id, customer_id, amount_due_usd_cents, other_charges_usd_cents, trust_at_time,
     status, cartons_expected, cartons_received, city, created_at)
  values
    (v_old.shipment_id, v_old.customer_id, p_amount_due_usd_cents, p_other_charges_usd_cents, v_old.trust_at_time,
     v_old.status, v_old.cartons_expected, v_old.cartons_received, v_old.city, v_old.created_at)
  returning id into v_new;

  perform gs_charge_consignment(v_new, p_user, v_at);
  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- Health check, now covering consignments and allocations
-- ---------------------------------------------------------------------------

create or replace function gs_ledger_health() returns table (problem text, detail text)
language sql stable as $$
  select 'entry_unbalanced', l.entry_id::text || ' ' || l.currency::text || ' off by ' || sum(l.amount)::text
  from journal_lines l group by l.entry_id, l.currency having sum(l.amount) <> 0
  union all
  select 'currency_total_not_zero', l.currency::text || ' sums to ' || sum(l.amount)::text
  from journal_lines l group by l.currency having sum(l.amount) <> 0
  union all
  select 'balance_cache_wrong', a.id::text || ' cached ' || coalesce(b.balance, 0)::text || ' actual ' || coalesce(s.total, 0)::text
  from accounts a
  left join account_balances b on b.account_id = a.id
  left join (select account_id, sum(amount) as total from journal_lines group by account_id) s on s.account_id = a.id
  where coalesce(b.balance, 0) <> coalesce(s.total, 0)
  union all
  select 'entry_without_lines', e.id::text
  from journal_entries e
  where (select count(*) from journal_lines l where l.entry_id = e.id) < 2
  union all
  select 'consignment_overpaid', cm.consignment_id::text || ' paid ' || cm.paid_usd_cents::text || ' of ' || cm.due_usd_cents::text
  from consignment_money cm where cm.paid_usd_cents > cm.due_usd_cents
  union all
  select 'payment_overallocated', p.entry_id::text || ' applied ' || p.allocated_usd_cents::text || ' of ' || p.credit_usd_cents::text
  from customer_payments p where p.allocated_usd_cents > p.credit_usd_cents
  union all
  select 'charge_without_consignment', e.id::text
  from journal_entries e
  where e.kind = 'file_confirmed'
    and not exists (select 1 from consignments c where c.charge_entry_id = e.id)
  union all
  select 'allocation_wrong_customer', al.id::text
  from allocations al
  join consignments c on c.id = al.consignment_id
  where not exists (
    select 1 from journal_lines l join accounts a on a.id = l.account_id
    where l.entry_id = al.entry_id and a.kind = 'customer' and a.customer_id = c.customer_id)
  union all
  select 'customer_balance_mismatch',
         c.id::text || ' balance ' || coalesce(b.balance_usd_cents, 0)::text
           || ' owed ' || coalesce(o.remaining, 0)::text || ' credit ' || coalesce(u.unallocated, 0)::text
  from customers c
  left join customer_balances b on b.customer_id = c.id
  left join (select customer_id, sum(remaining_usd_cents) as remaining from consignment_money group by customer_id) o
    on o.customer_id = c.id
  left join (select customer_id, sum(credit_usd_cents - allocated_usd_cents) as unallocated
             from customer_payments group by customer_id) u
    on u.customer_id = c.id
  where coalesce(b.balance_usd_cents, 0) <> coalesce(o.remaining, 0) - coalesce(u.unallocated, 0)
  union all
  select 'allocation_not_applied', c.id::text
  from customers c
  where exists (select 1 from consignment_money cm where cm.customer_id = c.id and cm.remaining_usd_cents > 0)
    and exists (select 1 from customer_payments p where p.customer_id = c.id and p.credit_usd_cents > p.allocated_usd_cents);
$$;

-- ---------------------------------------------------------------------------
-- The application's role
-- ---------------------------------------------------------------------------

grant select on customers, customer_trust_changes, customer_phones, customer_marks, customer_aliases,
                source_files, shipments, consignments, shipment_lines, disputes, allocations,
                effective_allocations, consignment_money, customer_payments, customers_over_limit
  to green_star_app;

-- Trust and limit are not in this list: they change through gs_set_customer_trust.
grant insert (id, display_name, kind), update (display_name, kind) on customers to green_star_app;
grant insert, update, delete on customer_phones, customer_marks, customer_aliases to green_star_app;
grant insert on source_files to green_star_app;
grant insert (id, code, source_file_id, arrived_on), update (code, source_file_id, arrived_on, status)
  on shipments to green_star_app;
-- charge_entry_id is not in this list: it is set by confirming the file.
grant insert (id, shipment_id, customer_id, amount_due_usd_cents, other_charges_usd_cents, trust_at_time,
              status, cartons_expected, cartons_received, city),
      update (customer_id, amount_due_usd_cents, other_charges_usd_cents, status,
              cartons_expected, cartons_received, city),
      delete
  on consignments to green_star_app;
grant insert, update, delete on shipment_lines to green_star_app;
grant insert, update on disputes to green_star_app;
