-- Rounds: the driver goes out with goods from any files, comes back with cash,
-- receipts and photos, and the CEO enters what happened to each customer.
--
-- There is no driver app. Everything here is entered in the office.
--
-- What the database guarantees here:
--   1. A consignment is on one round at a time, and only from a confirmed file.
--   2. Each stop has one result. Entering it again replaces it: the old
--      payment is reversed and the new one posted, in one transaction.
--   3. Money collected on a round is posted only by entering a result, and
--      moved to the vault only by a hand-in. Neither can be posted by hand.
--   4. A payment on a round pays that consignment first. What is left over
--      goes to the customer's oldest unpaid consignment, then stays as credit.
--   5. Goods go on account only for a trusted customer.
--   6. A hand-in is counted note by note. A gap needs a note, stays on the
--      round, and is never moved to the vault.
--   7. The status of a consignment and of a file is worked out from the
--      facts, never typed in. A file closes by itself.

create type carrier_kind as enum ('own_car', 'transport_office');
create type round_status as enum ('planned', 'out', 'returned', 'handed_in');
create type round_outcome as enum ('paid', 'on_account', 'prepaid', 'held', 'unpaid');
create type payment_method as enum ('driver_cash', 'office_cash', 'fib', 'fastpay', 'zaincash');
create type attachment_kind as enum ('payment_receipt', 'received_receipt', 'carton_photo');
create type cash_place as enum ('round', 'vault');

-- ---------------------------------------------------------------------------
-- Who carries the goods
-- ---------------------------------------------------------------------------

-- A named person with his own cash on each round. No login.
create table drivers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone      text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  constraint drivers_name_not_blank check (length(btrim(name)) > 0),
  constraint drivers_phone_format check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$')
);

-- Our own car or a transport office in another city. Either one holds cash
-- for a round exactly like a driver does.
create table carriers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  city       text,
  kind       carrier_kind not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  constraint carriers_name_not_blank check (length(btrim(name)) > 0)
);

-- ---------------------------------------------------------------------------
-- Rounds and stops
-- ---------------------------------------------------------------------------

create sequence rounds_number_seq;

create table rounds (
  id           uuid primary key default gen_random_uuid(),
  number       integer not null unique default nextval('rounds_number_seq'),  -- "Round 14"
  driver_id    uuid references drivers (id),
  carrier_id   uuid references carriers (id),
  status       round_status not null default 'planned',
  note         text,
  created_by   uuid not null,
  created_at   timestamptz not null default now(),
  left_at      timestamptz,
  returned_at  timestamptz,
  handed_in_at timestamptz,
  constraint rounds_driver_or_carrier check (driver_id is not null or carrier_id is not null),
  constraint rounds_left_fields check ((status = 'planned') = (left_at is null)),
  constraint rounds_returned_fields check ((status in ('returned', 'handed_in')) = (returned_at is not null)),
  constraint rounds_handed_in_fields check ((status = 'handed_in') = (handed_in_at is not null))
);

alter sequence rounds_number_seq owned by rounds.number;

alter table accounts
  add constraint accounts_round_fk foreign key (round_id) references rounds (id);

-- One stop per consignment on a round. The consignments can come from any
-- files: after a war pause one trip carries goods from several.
create table round_stops (
  id             uuid primary key default gen_random_uuid(),
  seq            bigint generated always as identity unique,   -- the order stops were added
  round_id       uuid not null references rounds (id),
  consignment_id uuid not null references consignments (id),
  status_before  consignment_status not null,                  -- listed, or held from an earlier round
  added_by       uuid not null,
  added_at       timestamptz not null default now(),
  unique (round_id, consignment_id)
);

create index round_stops_consignment on round_stops (consignment_id);

-- What happened at a stop, entered from the receipts and photos the driver
-- brings back. A result is never edited: entering it again voids the old one.
create table round_results (
  id                uuid primary key,          -- sent by the caller; the same id twice is one result
  round_id          uuid not null,
  consignment_id    uuid not null,
  outcome           round_outcome not null,
  trust_at_time     customer_trust not null,
  received_amount   bigint,                    -- what the customer handed over, as on the receipt
  received_currency currency,
  method            payment_method,
  iqd_per_100_usd   integer,                   -- the day's rate, when dinars were received
  credited_usd_cents bigint,                   -- what it was worth on the customer's account
  happened_at       timestamptz not null,      -- when the goods and money changed hands
  payment_entry_id  uuid references journal_entries (id),
  note              text,
  entered_by        uuid not null,
  entered_at        timestamptz not null default now(),
  voided_at         timestamptz,
  voided_by         uuid,
  void_reason       text,
  constraint round_results_stop_fk foreign key (round_id, consignment_id)
    references round_stops (round_id, consignment_id) on update cascade,
  constraint round_results_money_together check (
    (received_amount is null) = (received_currency is null)
    and (received_amount is null) = (method is null)
    and (received_amount is null) = (payment_entry_id is null)
    and (received_amount is null) = (credited_usd_cents is null)),
  constraint round_results_amount_positive check (received_amount is null or received_amount > 0),
  constraint round_results_method check (method is null or method <> 'office_cash'),
  constraint round_results_rate_with_dinars check (
    coalesce(received_currency = 'IQD', false) = (iqd_per_100_usd is not null)),
  constraint round_results_no_money_when_not_handed_over check (
    outcome not in ('held', 'prepaid') or received_amount is null),
  constraint round_results_void_fields check (
    (voided_at is null) = (voided_by is null) and (voided_at is null) = (void_reason is null))
);

create unique index round_results_one_current on round_results (round_id, consignment_id) where voided_at is null;
create unique index round_results_payment_entry on round_results (payment_entry_id) where payment_entry_id is not null;
create index round_results_consignment on round_results (consignment_id);

-- The receipts and photos that come back for a customer.
create table attachments (
  id             uuid primary key default gen_random_uuid(),
  consignment_id uuid not null references consignments (id),
  round_id       uuid references rounds (id),
  kind           attachment_kind not null,
  storage_key    text not null unique,
  uploaded_by    uuid not null,
  created_at     timestamptz not null default now(),
  constraint attachments_key_not_blank check (length(btrim(storage_key)) > 0)
);

create index attachments_consignment on attachments (consignment_id);

-- The CEO allowed a pay-first customer to take goods without paying in full.
-- Without one of these, "delivered, not paid" means the driver forgot to collect.
create table exceptions (
  id             uuid primary key default gen_random_uuid(),
  consignment_id uuid not null unique references consignments (id),
  approved_by    uuid not null,
  reason         text not null,
  created_at     timestamptz not null default now(),
  constraint exceptions_reason_not_blank check (length(btrim(reason)) > 0)
);

-- ---------------------------------------------------------------------------
-- Counting cash, note by note
-- ---------------------------------------------------------------------------

-- The notes in use. value is in the ledger's unit: cents for dollars, whole
-- dinars for dinars. A $100 note is 10000.
create table cash_denominations (
  currency currency not null,
  value    bigint not null check (value > 0),
  label    text not null,
  primary key (currency, value)
);

insert into cash_denominations (currency, value, label) values
  ('USD', 100, '$1'), ('USD', 200, '$2'), ('USD', 500, '$5'), ('USD', 1000, '$10'),
  ('USD', 2000, '$20'), ('USD', 5000, '$50'), ('USD', 10000, '$100'),
  ('IQD', 250, '250'), ('IQD', 500, '500'), ('IQD', 1000, '1,000'), ('IQD', 5000, '5,000'),
  ('IQD', 10000, '10,000'), ('IQD', 25000, '25,000'), ('IQD', 50000, '50,000');

-- A driver or carrier hands in a round's cash. There can be more than one:
-- the missing part of a short hand-in may arrive later.
create table round_hand_ins (
  id           uuid primary key,              -- sent by the caller; the same id twice is one hand-in
  round_id     uuid not null references rounds (id),
  entry_id     uuid unique references journal_entries (id),   -- null when nothing was counted
  happened_at  timestamptz not null,
  note         text,
  handed_in_by uuid not null,
  created_at   timestamptz not null default now(),
  voided_at    timestamptz,
  voided_by    uuid,
  void_reason  text,
  constraint round_hand_ins_void_fields check (
    (voided_at is null) = (voided_by is null) and (voided_at is null) = (void_reason is null))
);

create index round_hand_ins_round on round_hand_ins (round_id);

-- One count of one currency in one place: a round's hand-in now, the vault's
-- daily close when the money step lands.
create table cash_counts (
  id               bigint generated always as identity primary key,
  place            cash_place not null,
  round_hand_in_id uuid references round_hand_ins (id),
  currency         currency not null,
  notes            jsonb not null,            -- {"10000": 3, "5000": 1}: note value -> how many
  counted          bigint not null,
  expected         bigint not null,
  difference       bigint generated always as (counted - expected) stored,
  counted_by       uuid not null,
  counted_at       timestamptz not null default now(),
  constraint cash_counts_counted_not_negative check (counted >= 0),
  constraint cash_counts_round_has_hand_in check ((place = 'round') = (round_hand_in_id is not null)),
  unique (round_hand_in_id, currency)
);

create trigger cash_counts_no_change before update or delete on cash_counts
  for each row execute function gs_forbid_change();
create trigger cash_counts_no_truncate before truncate on cash_counts
  for each statement execute function gs_forbid_change();

-- Adds up a count. Refuses a note that does not exist and a count that is
-- not a whole number, so a typo cannot become money.
create function gs_count_notes(p_currency currency, p_notes jsonb) returns bigint
language plpgsql stable as $$
declare
  v_key   text;
  v_value jsonb;
  v_total bigint := 0;
begin
  if p_notes is null or jsonb_typeof(p_notes) = 'null' then
    return 0;
  end if;
  if jsonb_typeof(p_notes) <> 'object' then
    raise exception 'notes_invalid: a count is an object of note value to how many' using errcode = 'P0001';
  end if;
  for v_key, v_value in select key, value from jsonb_each(p_notes) loop
    if v_key !~ '^[0-9]{1,12}$'
       or not exists (select 1 from cash_denominations d where d.currency = p_currency and d.value = v_key::bigint) then
      raise exception 'note_unknown: there is no % note of %', p_currency, v_key using errcode = 'P0001';
    end if;
    if jsonb_typeof(v_value) <> 'number' or v_value::text !~ '^[0-9]{1,9}$' then
      raise exception 'notes_invalid: how many % notes of % must be a whole number, got %', p_currency, v_key, v_value
        using errcode = 'P0001';
    end if;
    v_total := v_total + v_key::bigint * (v_value::text)::bigint;
  end loop;
  return v_total;
end $$;

-- ---------------------------------------------------------------------------
-- Dinars to dollars, the same arithmetic as the app
-- ---------------------------------------------------------------------------

-- 123,250 IQD at 145,000 per $100 is 8500 cents. Half a cent rounds up.
create function gs_iqd_to_usd_cents(p_dinars bigint, p_iqd_per_100_usd integer) returns bigint
language sql immutable strict as $$
  select (p_dinars * 20000 + p_iqd_per_100_usd) / (2 * p_iqd_per_100_usd::bigint);
$$;

-- The rate of the Baghdad day an instant falls on.
create function gs_day_rate(p_at timestamptz) returns integer
language plpgsql stable as $$
declare
  v_rate integer;
begin
  select iqd_per_100_usd into v_rate from fx_rates where day = (p_at at time zone 'Asia/Baghdad')::date;
  if v_rate is null then
    raise exception 'rate_missing: set the dinar rate for % first', (p_at at time zone 'Asia/Baghdad')::date
      using errcode = 'P0001';
  end if;
  return v_rate;
end $$;

-- One customer's money and consignments change in one transaction at a time.
-- Every function that touches them takes this lock first, before it writes a
-- ledger line or locks a row, and takes several customers in id order. Two
-- transactions that follow the rule cannot wait on each other in a circle.
create function gs_lock_customer(p_customer_id uuid) returns void
language sql as $$
  select pg_advisory_xact_lock(hashtextextended('gs_allocate:' || p_customer_id::text, 0));
$$;

create function gs_lock_customers(p_customer_ids uuid[]) returns void
language plpgsql as $$
declare
  v_id uuid;
begin
  for v_id in select distinct x from unnest(p_customer_ids) as x where x is not null order by x loop
    perform gs_lock_customer(v_id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- A payment can name the consignment it was paid for
-- ---------------------------------------------------------------------------

create table payment_targets (
  entry_id       uuid primary key references journal_entries (id),
  consignment_id uuid not null references consignments (id)
);

create index payment_targets_consignment on payment_targets (consignment_id);

-- A payment made for one consignment pays that consignment first. Whatever
-- is left, and every other payment, goes to the oldest unpaid first.
create or replace function gs_allocate_customer(p_customer_id uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pay    record;
  v_con    record;
  v_left   bigint;
  v_take   bigint;
  v_count  integer := 0;
begin
  -- A correction swaps one consignment for another in several steps. Money is
  -- applied once, at the end, when the replacement is in place.
  if coalesce(current_setting('gs.hold_allocation', true), '') = 'on' then
    return 0;
  end if;
  perform gs_lock_customer(p_customer_id);

  for v_pay in
    select entry_id, credit_usd_cents - allocated_usd_cents as unallocated
    from customer_payments
    where customer_id = p_customer_id and credit_usd_cents > allocated_usd_cents
    order by happened_at, created_at, entry_id
  loop
    v_left := v_pay.unallocated;

    select cm.consignment_id, cm.remaining_usd_cents into v_con
    from payment_targets t
    join consignment_money cm on cm.consignment_id = t.consignment_id
    where t.entry_id = v_pay.entry_id and cm.customer_id = p_customer_id and cm.remaining_usd_cents > 0;
    if found then
      v_take := least(v_left, v_con.remaining_usd_cents);
      insert into allocations (entry_id, consignment_id, amount_usd_cents)
      values (v_pay.entry_id, v_con.consignment_id, v_take);
      v_left := v_left - v_take;
      v_count := v_count + 1;
    end if;

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

  -- What is paid decides what is closed.
  perform gs_refresh_customer(p_customer_id);
  return v_count;
end $$;

-- gs_post_entry gains one optional argument: the consignment a payment was
-- made for. Everything else is as before.
drop function gs_post_entry(entry_kind, timestamptz, uuid, text, jsonb, text, integer, uuid);

create function gs_post_entry(
  p_kind              entry_kind,
  p_happened_at       timestamptz,
  p_created_by        uuid,
  p_idempotency_key   text,
  p_lines             jsonb,
  p_reason            text default null,
  p_rate              integer default null,
  p_reverses_id       uuid default null,
  p_for_consignment   uuid default null
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

  -- The customers this entry touches are locked before anything is written.
  perform gs_lock_customers(array(
    select a.customer_id
    from jsonb_array_elements(p_lines) as l
    join accounts a on a.id = (l ->> 'account_id')::uuid
    where a.kind = 'customer'));

  insert into journal_entries (kind, happened_at, created_by, reason, reverses_id, idempotency_key, iqd_per_100_usd)
  values (p_kind, p_happened_at, p_created_by, nullif(btrim(p_reason), ''), p_reverses_id, p_idempotency_key, p_rate)
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from journal_entries where idempotency_key = p_idempotency_key;
    return v_id;
  end if;

  -- Lines go in by account, so two entries always reach the same accounts in the same order.
  insert into journal_lines (entry_id, account_id, currency, amount)
  select v_id,
         (l ->> 'account_id')::uuid,
         (l ->> 'currency')::currency,
         (l ->> 'amount')::bigint
  from jsonb_array_elements(p_lines) as l
  order by l ->> 'account_id', l ->> 'currency', (l ->> 'amount')::bigint;

  -- Run the commit-time checks now, so the caller gets the error here.
  set constraints journal_lines_balanced, journal_entries_complete immediate;
  set constraints journal_lines_balanced, journal_entries_complete deferred;

  if p_for_consignment is not null then
    if not exists (
      select 1
      from journal_lines l
      join accounts a on a.id = l.account_id and a.kind = 'customer'
      join consignments c on c.customer_id = a.customer_id
      where l.entry_id = v_id and c.id = p_for_consignment and l.amount < 0
    ) then
      raise exception 'target_invalid: a payment can only be made for a consignment of the customer it credits'
        using errcode = 'P0001';
    end if;
    insert into payment_targets (entry_id, consignment_id) values (v_id, p_for_consignment);
  end if;

  perform gs_allocate_customer(t.customer_id)
  from (select distinct a.customer_id
        from journal_lines l join accounts a on a.id = l.account_id
        where l.entry_id = v_id and a.kind = 'customer'
        order by a.customer_id) t;

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Guard: round money is posted by the round, not by hand
-- ---------------------------------------------------------------------------

create or replace function gs_charge_entries_guard() returns trigger
language plpgsql as $$
declare
  v_kind entry_kind;
begin
  if gs_is_owner() then
    return new;
  end if;
  if new.kind = 'file_confirmed' then
    raise exception 'charge_needs_consignment: a charge is posted by gs_confirm_shipment' using errcode = 'P0001';
  end if;
  if new.kind = 'driver_collected' then
    raise exception 'round_money_needs_round: a collection is posted by entering a round result' using errcode = 'P0001';
  end if;
  if new.kind = 'round_handed_in' then
    raise exception 'round_money_needs_round: a hand-in is posted by gs_hand_in_round' using errcode = 'P0001';
  end if;
  if new.reverses_id is not null then
    select kind into v_kind from journal_entries where id = new.reverses_id;
    if v_kind = 'file_confirmed' then
      raise exception 'charge_needs_consignment: a charge is reversed by gs_cancel_consignment' using errcode = 'P0001';
    end if;
    if v_kind = 'driver_collected'
       or exists (select 1 from round_results r where r.payment_entry_id = new.reverses_id) then
      raise exception 'round_money_needs_round: change the round result instead of reversing its payment'
        using errcode = 'P0001';
    end if;
    if v_kind = 'round_handed_in' then
      raise exception 'round_money_needs_round: a hand-in is undone by gs_void_hand_in' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Status, worked out from the facts
-- ---------------------------------------------------------------------------

-- The latest stop of each consignment, with its result when one is entered.
create view consignment_last_stop as
select distinct on (s.consignment_id)
       s.consignment_id,
       s.round_id,
       s.id as stop_id,
       rd.status as round_status,
       r.id as result_id,
       r.outcome,
       r.trust_at_time,
       r.happened_at
from round_stops s
join rounds rd on rd.id = s.round_id
left join round_results r
  on r.round_id = s.round_id and r.consignment_id = s.consignment_id and r.voided_at is null
order by s.consignment_id, s.seq desc;

-- listed -> on_round -> held (goes out again), or delivered one of four ways
-- -> closed once it is paid in full and its round's cash is handed in.
--
-- Once the goods are handed over, the status follows what is owed, not the
-- word that was picked on the screen: a trusted customer who still owes is
-- on account, a pay-first customer who still owes is not paid, and anyone who
-- owes nothing is paid.
create function gs_derived_consignment_status(p_consignment_id uuid) returns consignment_status
language sql stable as $$
  select case
           when c.status = 'cancelled' then 'cancelled'
           when ls.consignment_id is null then 'listed'
           when ls.result_id is null then 'on_round'
           when ls.outcome = 'held' then 'held'
           when cm.remaining_usd_cents = 0 and ls.round_status = 'handed_in' then 'closed'
           when cm.remaining_usd_cents = 0 and c.amount_due_usd_cents = 0 then 'delivered_prepaid'
           when cm.remaining_usd_cents = 0 then 'delivered_paid'
           when ls.trust_at_time = 'trusted' then 'delivered_on_account'
           else 'delivered_not_paid'
         end::consignment_status
  from consignments c
  join consignment_money cm on cm.consignment_id = c.id
  left join consignment_last_stop ls on ls.consignment_id = c.id
  where c.id = p_consignment_id;
$$;

-- A file closes by itself when every customer on it is paid, prepaid, or
-- delivered on account to a trusted customer, the rounds that carried it are
-- handed in, and no dispute is waiting on China.
create function gs_derived_shipment_status(p_shipment_id uuid) returns shipment_status
language sql stable as $$
  select case
           when s.status = 'draft' then 'draft'
           when n.total = 0 or n.listed = n.total then 'confirmed'
           when n.not_delivered > 0 then 'on_rounds'
           when n.settled = n.total and not exists (
                  select 1 from disputes d join consignments dc on dc.id = d.consignment_id
                  where dc.shipment_id = s.id and d.status in ('open', 'sent_to_china'))
             then 'closed'
           else 'reconciling'
         end::shipment_status
  from shipments s
  cross join lateral (
    select count(*) as total,
           count(*) filter (where c.status = 'listed') as listed,
           count(*) filter (where c.status in ('listed', 'on_round', 'held')) as not_delivered,
           count(*) filter (where c.status = 'closed'
                               or (c.status = 'delivered_on_account' and ls.round_status = 'handed_in')) as settled
    from consignments c
    left join consignment_last_stop ls on ls.consignment_id = c.id
    where c.shipment_id = s.id and c.status <> 'cancelled'
  ) n
  where s.id = p_shipment_id;
$$;

create function gs_refresh_shipments(p_shipment_ids uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  for v_id in select distinct x from unnest(p_shipment_ids) as x where x is not null order by x loop
    update shipments s
       set status = gs_derived_shipment_status(v_id)
     where s.id = v_id and s.status <> 'draft' and s.status is distinct from gs_derived_shipment_status(v_id);
  end loop;
end $$;

-- Brings one customer's consignments, and the files they are on, in line
-- with the facts. Called whenever money or a round changes.
create function gs_refresh_customer(p_customer_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shipments uuid[];
begin
  perform gs_lock_customer(p_customer_id);

  update consignments c
     set status = gs_derived_consignment_status(c.id)
    from shipments s
   where s.id = c.shipment_id and s.status <> 'draft'
     and c.customer_id = p_customer_id and c.status <> 'cancelled'
     and c.status is distinct from gs_derived_consignment_status(c.id);

  select array_agg(distinct c.shipment_id) into v_shipments
  from consignments c where c.customer_id = p_customer_id;
  perform gs_refresh_shipments(v_shipments);
end $$;

revoke all on function gs_refresh_shipments(uuid[]) from public;
revoke all on function gs_refresh_customer(uuid) from public;

-- A dispute waiting on China keeps its file open; China's answer lets it close.
create function gs_disputes_refresh() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform gs_refresh_shipments(array(select c.shipment_id from consignments c where c.id = new.consignment_id));
  if tg_op = 'UPDATE' and old.consignment_id <> new.consignment_id then
    perform gs_refresh_shipments(array(select c.shipment_id from consignments c where c.id = old.consignment_id));
  end if;
  return null;
end $$;

create trigger disputes_refresh after insert or update on disputes
  for each row execute function gs_disputes_refresh();

-- ---------------------------------------------------------------------------
-- Building a round
-- ---------------------------------------------------------------------------

create function gs_rounds_guard() returns trigger
language plpgsql as $$
begin
  if gs_is_owner() then
    return new;
  end if;
  if old.status <> 'planned'
     and (new.driver_id, new.carrier_id) is distinct from (old.driver_id, old.carrier_id) then
    raise exception 'round_locked: the driver and carrier cannot change once the round has left' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger rounds_guard before update on rounds
  for each row execute function gs_rounds_guard();

-- Puts a consignment on a round, with the cartons counted at the airport.
-- Calling it again for the same stop only updates the carton count.
create function gs_add_round_stop(
  p_round_id       uuid,
  p_consignment_id uuid,
  p_user           uuid,
  p_cartons_counted integer default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_round    rounds%rowtype;
  v_con      consignments%rowtype;
  v_customer uuid;
  v_file     shipment_status;
  v_stop     uuid;
begin
  select * into v_round from rounds where id = p_round_id for update;
  if not found then
    raise exception 'round_not_found: %', p_round_id using errcode = 'P0001';
  end if;
  if v_round.status = 'handed_in' then
    raise exception 'round_handed_in: round % is already handed in', v_round.number using errcode = 'P0001';
  end if;
  if p_cartons_counted is not null and p_cartons_counted < 0 then
    raise exception 'cartons_invalid: a carton count cannot be negative' using errcode = 'P0001';
  end if;

  select customer_id into v_customer from consignments where id = p_consignment_id;
  if not found then
    raise exception 'consignment_not_found: %', p_consignment_id using errcode = 'P0001';
  end if;
  perform gs_lock_customer(v_customer);
  select * into v_con from consignments where id = p_consignment_id for update;

  select id into v_stop from round_stops where round_id = p_round_id and consignment_id = p_consignment_id;
  if v_stop is not null then
    if p_cartons_counted is not null then
      update consignments set cartons_received = p_cartons_counted where id = p_consignment_id;
    end if;
    return v_stop;
  end if;

  select status into v_file from shipments where id = v_con.shipment_id;
  if v_file = 'draft' then
    raise exception 'file_not_confirmed: confirm the file before its goods go on a round' using errcode = 'P0001';
  end if;
  if v_con.status not in ('listed', 'held') then
    raise exception 'consignment_not_available: it is % and cannot go on a round', v_con.status using errcode = 'P0001';
  end if;

  insert into round_stops (round_id, consignment_id, status_before, added_by)
  values (p_round_id, p_consignment_id, v_con.status, p_user)
  returning id into v_stop;

  if p_cartons_counted is not null then
    update consignments set cartons_received = p_cartons_counted where id = p_consignment_id;
  end if;
  perform gs_refresh_customer(v_customer);
  return v_stop;
end $$;

-- Takes a consignment off a round it was put on by mistake. Not possible
-- once a result has been entered for it.
create function gs_remove_round_stop(p_round_id uuid, p_consignment_id uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_customer uuid;
begin
  perform 1 from rounds where id = p_round_id for update;
  select customer_id into v_customer from consignments where id = p_consignment_id;
  if not found then
    return;
  end if;
  perform gs_lock_customer(v_customer);
  if exists (select 1 from round_results where round_id = p_round_id and consignment_id = p_consignment_id) then
    raise exception 'stop_has_result: a result was entered for this stop. Enter it as held instead.' using errcode = 'P0001';
  end if;
  delete from round_stops where round_id = p_round_id and consignment_id = p_consignment_id;
  perform gs_refresh_customer(v_customer);
end $$;

-- The driver leaves.
create function gs_round_depart(p_round_id uuid, p_user uuid, p_at timestamptz default now()) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_round rounds%rowtype;
begin
  select * into v_round from rounds where id = p_round_id for update;
  if not found then
    raise exception 'round_not_found: %', p_round_id using errcode = 'P0001';
  end if;
  if v_round.status <> 'planned' then
    return;
  end if;
  if not exists (select 1 from round_stops where round_id = p_round_id) then
    raise exception 'round_empty: put at least one consignment on the round first' using errcode = 'P0001';
  end if;
  update rounds set status = 'out', left_at = p_at where id = p_round_id;
end $$;

-- The driver is back. Entering the first result does this by itself.
create function gs_round_return(p_round_id uuid, p_user uuid, p_at timestamptz default now()) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_round rounds%rowtype;
begin
  select * into v_round from rounds where id = p_round_id for update;
  if not found then
    raise exception 'round_not_found: %', p_round_id using errcode = 'P0001';
  end if;
  if v_round.status = 'planned' then
    raise exception 'round_not_left: round % has not left yet', v_round.number using errcode = 'P0001';
  end if;
  if v_round.status = 'out' then
    update rounds set status = 'returned', returned_at = p_at where id = p_round_id;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Entering results
-- ---------------------------------------------------------------------------

-- Voids one result and reverses its payment. Internal: callers hold the
-- round and customer locks.
create function gs_void_result_inner(p_result_id uuid, p_user uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res round_results%rowtype;
begin
  select * into v_res from round_results where id = p_result_id for update;
  if v_res.voided_at is not null then
    return;
  end if;
  if v_res.payment_entry_id is not null
     and not exists (select 1 from journal_entries r where r.reverses_id = v_res.payment_entry_id) then
    perform gs_reverse_entry(v_res.payment_entry_id, p_user, p_reason, 'void_result:' || p_result_id::text);
  end if;
  update round_results
     set voided_at = now(), voided_by = p_user, void_reason = btrim(p_reason)
   where id = p_result_id;
end $$;

revoke all on function gs_void_result_inner(uuid, uuid, text) from public;

-- What happened at one stop. Entering a result for a stop that already has
-- one replaces it: the old payment is reversed and the new one posted.
--
-- paid        goods handed over and money received (or already paid before)
-- on_account  goods handed over to a trusted customer; what is unpaid goes on his account
-- prepaid     goods handed over, nothing to collect ($0 on the file)
-- held        goods stay in the car; no money
-- unpaid      goods handed over to a pay-first customer without full payment
create function gs_enter_round_result(
  p_id                uuid,
  p_round_id          uuid,
  p_consignment_id    uuid,
  p_outcome           round_outcome,
  p_user              uuid,
  p_happened_at       timestamptz,
  p_received_amount   bigint default null,
  p_received_currency currency default null,
  p_method            payment_method default null,
  p_note              text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing round_results%rowtype;
  v_round    rounds%rowtype;
  v_con      consignments%rowtype;
  v_customer uuid;
  v_trust    customer_trust;
  v_name     text;
  v_remaining bigint;
  v_current  uuid;
  v_rate     integer;
  v_cents    bigint;
  v_into     uuid;
  v_entry    uuid;
  v_kind     entry_kind;
  v_cust_acc uuid;
begin
  if p_id is null then
    raise exception 'result_id_required' using errcode = 'P0001';
  end if;
  if p_happened_at is null then
    raise exception 'happened_at_required: say when the goods and money changed hands' using errcode = 'P0001';
  end if;

  select * into v_round from rounds where id = p_round_id for update;
  if not found then
    raise exception 'round_not_found: %', p_round_id using errcode = 'P0001';
  end if;

  select * into v_existing from round_results where id = p_id;
  if found then
    if (v_existing.round_id, v_existing.consignment_id) is distinct from (p_round_id, p_consignment_id) then
      raise exception 'result_id_reused: this id belongs to another stop' using errcode = 'P0001';
    end if;
    return p_id;   -- the same request again
  end if;

  if v_round.status = 'planned' then
    raise exception 'round_not_left: round % has not left yet', v_round.number using errcode = 'P0001';
  end if;
  if not exists (select 1 from round_stops where round_id = p_round_id and consignment_id = p_consignment_id) then
    raise exception 'stop_not_found: this consignment is not on round %', v_round.number using errcode = 'P0001';
  end if;

  select customer_id into v_customer from consignments where id = p_consignment_id;
  perform gs_lock_customer(v_customer);
  select * into v_con from consignments where id = p_consignment_id for update;
  if v_con.status = 'cancelled' then
    raise exception 'consignment_cancelled: % is cancelled', p_consignment_id using errcode = 'P0001';
  end if;
  select trust, display_name into v_trust, v_name from customers where id = v_customer;

  -- The money fields come together or not at all.
  if p_received_amount is null then
    if p_received_currency is not null or p_method is not null then
      raise exception 'payment_incomplete: a currency or method was given without an amount' using errcode = 'P0001';
    end if;
  else
    if p_received_amount <= 0 then
      raise exception 'amount_invalid: the amount received must be more than zero' using errcode = 'P0001';
    end if;
    if p_received_currency is null or p_method is null then
      raise exception 'payment_incomplete: an amount needs its currency and method' using errcode = 'P0001';
    end if;
    if p_method = 'office_cash' then
      raise exception 'method_invalid: money taken on a round is driver cash or a wallet' using errcode = 'P0001';
    end if;
  end if;

  -- Replace the result already on this stop, if there is one, before
  -- looking at what is still owed.
  select id into v_current from round_results
  where round_id = p_round_id and consignment_id = p_consignment_id and voided_at is null;
  if v_current is not null then
    perform gs_void_result_inner(v_current, p_user, 'Replaced by a new result');
  end if;

  select remaining_usd_cents into v_remaining from consignment_money where consignment_id = p_consignment_id;

  if v_con.amount_due_usd_cents = 0 and p_outcome not in ('prepaid', 'held') then
    raise exception 'outcome_invalid: this consignment is prepaid. Use prepaid, or held if the goods stayed in the car.'
      using errcode = 'P0001';
  end if;
  case p_outcome
    when 'prepaid' then
      if v_con.amount_due_usd_cents <> 0 then
        raise exception 'outcome_invalid: this consignment is not prepaid' using errcode = 'P0001';
      end if;
      if p_received_amount is not null then
        raise exception 'outcome_invalid: a prepaid consignment has nothing to collect' using errcode = 'P0001';
      end if;
    when 'held' then
      if p_received_amount is not null then
        raise exception 'outcome_invalid: goods held in the car take no money. Enter the payment at the office instead.'
          using errcode = 'P0001';
      end if;
    when 'on_account' then
      if v_trust <> 'trusted' then
        raise exception 'not_trusted: % is pay first and cannot take goods on account. Use unpaid, with an exception if it was allowed.', v_name
          using errcode = 'P0001';
      end if;
    when 'unpaid' then
      if v_trust = 'trusted' then
        raise exception 'outcome_invalid: % is trusted. Use on_account.', v_name using errcode = 'P0001';
      end if;
    when 'paid' then
      if p_received_amount is null and v_remaining > 0 then
        raise exception 'payment_missing: paid needs the amount received' using errcode = 'P0001';
      end if;
  end case;

  if p_received_amount is not null then
    v_cust_acc := gs_customer_account(v_customer, v_name);
    if p_method = 'driver_cash' then
      v_kind := 'driver_collected';
      v_into := gs_driver_cash_account(
        p_round_id, p_received_currency, 'Round ' || v_round.number || ' cash, ' || p_received_currency);
    else
      v_kind := 'wallet_payment';
      v_into := gs_account('wallet_' || p_method::text || '_' || lower(p_received_currency::text));
    end if;

    if p_received_currency = 'USD' then
      v_cents := p_received_amount;
      v_entry := gs_post_entry(
        v_kind, p_happened_at, p_user, 'round_result:' || p_id::text,
        jsonb_build_array(
          jsonb_build_object('account_id', v_into, 'currency', 'USD', 'amount', p_received_amount),
          jsonb_build_object('account_id', v_cust_acc, 'currency', 'USD', 'amount', -p_received_amount)),
        null, null, null, p_consignment_id);
    else
      v_rate := gs_day_rate(p_happened_at);
      v_cents := gs_iqd_to_usd_cents(p_received_amount, v_rate);
      if v_cents <= 0 then
        raise exception 'amount_invalid: % IQD is worth less than a cent', p_received_amount using errcode = 'P0001';
      end if;
      v_entry := gs_post_entry(
        v_kind, p_happened_at, p_user, 'round_result:' || p_id::text,
        jsonb_build_array(
          jsonb_build_object('account_id', v_into, 'currency', 'IQD', 'amount', p_received_amount),
          jsonb_build_object('account_id', gs_account('exchange_clearing_iqd'), 'currency', 'IQD', 'amount', -p_received_amount),
          jsonb_build_object('account_id', gs_account('exchange_clearing_usd'), 'currency', 'USD', 'amount', v_cents),
          jsonb_build_object('account_id', v_cust_acc, 'currency', 'USD', 'amount', -v_cents)),
        null, v_rate, null, p_consignment_id);
    end if;
  end if;

  insert into round_results
    (id, round_id, consignment_id, outcome, trust_at_time, received_amount, received_currency, method,
     iqd_per_100_usd, credited_usd_cents, happened_at, payment_entry_id, note, entered_by)
  values
    (p_id, p_round_id, p_consignment_id, p_outcome, v_trust, p_received_amount, p_received_currency, p_method,
     v_rate, v_cents, p_happened_at, v_entry, nullif(btrim(p_note), ''), p_user);

  if v_round.status = 'out' then
    update rounds set status = 'returned', returned_at = now() where id = p_round_id;
  end if;

  perform gs_refresh_customer(v_customer);
  return p_id;
end $$;

-- Takes a result back without entering another: the stop is open again.
create function gs_void_round_result(p_result_id uuid, p_user uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res      round_results%rowtype;
  v_customer uuid;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'reason_required: say why the result is taken back' using errcode = 'P0001';
  end if;
  select * into v_res from round_results where id = p_result_id;
  if not found then
    raise exception 'result_not_found: %', p_result_id using errcode = 'P0001';
  end if;
  perform 1 from rounds where id = v_res.round_id for update;
  select customer_id into v_customer from consignments where id = v_res.consignment_id;
  perform gs_lock_customer(v_customer);
  perform gs_void_result_inner(p_result_id, p_user, p_reason);
  perform gs_refresh_customer(v_customer);
end $$;

-- ---------------------------------------------------------------------------
-- Handing in the cash
-- ---------------------------------------------------------------------------

-- Locks every customer with goods on a round, in id order.
create function gs_lock_round_customers(p_round_id uuid) returns void
language sql as $$
  select gs_lock_customers(array(
    select c.customer_id from round_stops s join consignments c on c.id = s.consignment_id
    where s.round_id = p_round_id));
$$;

-- Brings the consignments on a round, and their files, in line with the
-- facts. The caller holds the round's customers.
create function gs_refresh_round(p_round_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update consignments c
     set status = gs_derived_consignment_status(c.id)
   where c.id in (select s.consignment_id from round_stops s where s.round_id = p_round_id)
     and c.status <> 'cancelled'
     and c.status is distinct from gs_derived_consignment_status(c.id);

  perform gs_refresh_shipments(array(
    select c.shipment_id from round_stops s join consignments c on c.id = s.consignment_id
    where s.round_id = p_round_id));
end $$;

revoke all on function gs_refresh_round(uuid) from public;

-- The driver hands in the round's cash and the CEO counts it note by note.
-- Only what was counted moves to the vault. A gap stays on the round and
-- needs a note. Every stop must have its result first.
--
-- p_usd_notes, p_iqd_notes: {"10000": 3, "5000": 1} is three $100 notes and one $50.
create function gs_hand_in_round(
  p_id          uuid,
  p_round_id    uuid,
  p_user        uuid,
  p_happened_at timestamptz,
  p_usd_notes   jsonb default null,
  p_iqd_notes   jsonb default null,
  p_note        text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing    round_hand_ins%rowtype;
  v_round       rounds%rowtype;
  v_missing     integer;
  v_counted_usd bigint;
  v_counted_iqd bigint;
  v_expected_usd bigint;
  v_expected_iqd bigint;
  v_lines       jsonb := '[]'::jsonb;
  v_entry       uuid;
begin
  if p_id is null then
    raise exception 'hand_in_id_required' using errcode = 'P0001';
  end if;
  if p_happened_at is null then
    raise exception 'happened_at_required: say when the cash was handed in' using errcode = 'P0001';
  end if;

  select * into v_round from rounds where id = p_round_id for update;
  if not found then
    raise exception 'round_not_found: %', p_round_id using errcode = 'P0001';
  end if;

  select * into v_existing from round_hand_ins where id = p_id;
  if found then
    if v_existing.round_id <> p_round_id then
      raise exception 'hand_in_id_reused: this id belongs to another round' using errcode = 'P0001';
    end if;
    return p_id;   -- the same request again
  end if;

  if v_round.status in ('planned', 'out') then
    raise exception 'round_not_back: enter the results of round % first', v_round.number using errcode = 'P0001';
  end if;
  perform gs_lock_round_customers(p_round_id);

  select count(*) into v_missing
  from round_stops s
  join consignments c on c.id = s.consignment_id
  where s.round_id = p_round_id and c.status <> 'cancelled'
    and not exists (select 1 from round_results r
                    where r.round_id = s.round_id and r.consignment_id = s.consignment_id and r.voided_at is null);
  if v_missing > 0 then
    raise exception 'results_missing: % stop(s) on round % have no result yet', v_missing, v_round.number
      using errcode = 'P0001';
  end if;

  v_counted_usd := gs_count_notes('USD', p_usd_notes);
  v_counted_iqd := gs_count_notes('IQD', p_iqd_notes);

  select coalesce(sum(b.balance) filter (where a.currency = 'USD'), 0),
         coalesce(sum(b.balance) filter (where a.currency = 'IQD'), 0)
    into v_expected_usd, v_expected_iqd
  from accounts a join account_balances b on b.account_id = a.id
  where a.kind = 'driver_cash' and a.round_id = p_round_id;

  if (v_counted_usd <> v_expected_usd or v_counted_iqd <> v_expected_iqd)
     and length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'gap_note_required: counted % USD cents and % IQD, expected % and %. Say why they differ.',
      v_counted_usd, v_counted_iqd, v_expected_usd, v_expected_iqd using errcode = 'P0001';
  end if;
  if v_round.status = 'handed_in' and v_counted_usd = 0 and v_counted_iqd = 0 then
    raise exception 'nothing_counted: round % is already handed in and nothing was counted', v_round.number
      using errcode = 'P0001';
  end if;

  if v_counted_usd > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', gs_account('vault_usd'), 'currency', 'USD', 'amount', v_counted_usd),
      jsonb_build_object('account_id', gs_driver_cash_account(p_round_id, 'USD', 'Round ' || v_round.number || ' cash, USD'),
                         'currency', 'USD', 'amount', -v_counted_usd));
  end if;
  if v_counted_iqd > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', gs_account('vault_iqd'), 'currency', 'IQD', 'amount', v_counted_iqd),
      jsonb_build_object('account_id', gs_driver_cash_account(p_round_id, 'IQD', 'Round ' || v_round.number || ' cash, IQD'),
                         'currency', 'IQD', 'amount', -v_counted_iqd));
  end if;
  if jsonb_array_length(v_lines) > 0 then
    v_entry := gs_post_entry('round_handed_in', p_happened_at, p_user, 'hand_in:' || p_id::text, v_lines,
                             nullif(btrim(p_note), ''));
  end if;

  insert into round_hand_ins (id, round_id, entry_id, happened_at, note, handed_in_by)
  values (p_id, p_round_id, v_entry, p_happened_at, nullif(btrim(p_note), ''), p_user);

  insert into cash_counts (place, round_hand_in_id, currency, notes, counted, expected, counted_by) values
    ('round', p_id, 'USD', coalesce(p_usd_notes, '{}'::jsonb), v_counted_usd, v_expected_usd, p_user),
    ('round', p_id, 'IQD', coalesce(p_iqd_notes, '{}'::jsonb), v_counted_iqd, v_expected_iqd, p_user);

  if v_round.status <> 'handed_in' then
    update rounds set status = 'handed_in', handed_in_at = p_happened_at where id = p_round_id;
  end if;

  perform gs_refresh_round(p_round_id);
  return p_id;
end $$;

-- A hand-in that was counted or typed wrong is taken back whole and entered
-- again. The cash goes back onto the round.
create function gs_void_hand_in(p_hand_in_id uuid, p_user uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_hand_in round_hand_ins%rowtype;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'reason_required: say why the hand-in is taken back' using errcode = 'P0001';
  end if;
  select * into v_hand_in from round_hand_ins where id = p_hand_in_id;
  if not found then
    raise exception 'hand_in_not_found: %', p_hand_in_id using errcode = 'P0001';
  end if;
  perform 1 from rounds where id = v_hand_in.round_id for update;
  select * into v_hand_in from round_hand_ins where id = p_hand_in_id for update;
  if v_hand_in.voided_at is not null then
    return;
  end if;
  perform gs_lock_round_customers(v_hand_in.round_id);
  if v_hand_in.entry_id is not null then
    perform gs_reverse_entry(v_hand_in.entry_id, p_user, p_reason, 'void_hand_in:' || p_hand_in_id::text);
  end if;
  update round_hand_ins
     set voided_at = now(), voided_by = p_user, void_reason = btrim(p_reason)
   where id = p_hand_in_id;
  if not exists (select 1 from round_hand_ins where round_id = v_hand_in.round_id and voided_at is null) then
    update rounds set status = 'returned', handed_in_at = null where id = v_hand_in.round_id;
  end if;
  perform gs_refresh_round(v_hand_in.round_id);
end $$;

-- ---------------------------------------------------------------------------
-- Exceptions
-- ---------------------------------------------------------------------------

create function gs_exceptions_guard() returns trigger
language plpgsql as $$
declare
  v_con consignments%rowtype;
begin
  select * into v_con from consignments where id = new.consignment_id;
  if v_con.status = 'cancelled' then
    raise exception 'consignment_cancelled: % is cancelled', new.consignment_id using errcode = 'P0001';
  end if;
  if v_con.amount_due_usd_cents = 0 then
    raise exception 'exception_not_needed: this consignment is prepaid' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger exceptions_guard before insert on exceptions
  for each row execute function gs_exceptions_guard();

-- ---------------------------------------------------------------------------
-- Confirming, cancelling and fixing, with the customer locked first
-- ---------------------------------------------------------------------------

-- Same as before, and every customer on the file is locked before the first charge.
create or replace function gs_confirm_shipment(p_shipment_id uuid, p_user uuid, p_happened_at timestamptz default now())
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status shipment_status;
  v_con    record;
  v_count  integer := 0;
begin
  perform gs_lock_customers(array(select customer_id from consignments where shipment_id = p_shipment_id));
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

-- Same as before, and the customer is locked before the consignment is.
create or replace function gs_cancel_consignment(p_consignment_id uuid, p_user uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_con consignments%rowtype;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'reason_required: say why the consignment is cancelled' using errcode = 'P0001';
  end if;
  select customer_id into v_con.customer_id from consignments where id = p_consignment_id;
  if not found then
    raise exception 'consignment_not_found: %', p_consignment_id using errcode = 'P0001';
  end if;
  perform gs_lock_customer(v_con.customer_id);
  select * into v_con from consignments where id = p_consignment_id for update;
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

-- Same as before, and the replacement takes over the old one's stops,
-- results, documents, exception and disputes: it is the same goods for the
-- same customer, with the right amount.

-- Same as before, and the replacement takes over the old one's stops,
-- results, documents, exception and disputes: it is the same goods for the
-- same customer, with the right amount.
create or replace function gs_correct_consignment(
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
  select customer_id into v_old.customer_id from consignments where id = p_consignment_id;
  if not found then
    raise exception 'consignment_not_found: %', p_consignment_id using errcode = 'P0001';
  end if;
  perform gs_lock_customer(v_old.customer_id);
  select * into v_old from consignments where id = p_consignment_id for update;
  if v_old.status = 'cancelled' then
    raise exception 'consignment_cancelled: % is already cancelled', p_consignment_id using errcode = 'P0001';
  end if;
  select status, confirmed_at into v_status, v_at from shipments where id = v_old.shipment_id;
  if v_status = 'draft' then
    raise exception 'shipment_draft: edit the consignment directly while the file is a draft' using errcode = 'P0001';
  end if;
  if p_amount_due_usd_cents = 0 and exists (
       select 1 from round_results r
       where r.consignment_id = p_consignment_id and r.voided_at is null and r.outcome not in ('prepaid', 'held')) then
    raise exception 'correction_invalid: take back the round result before making this consignment prepaid'
      using errcode = 'P0001';
  end if;

  -- Until the replacement is in place, money that had paid the old
  -- consignment is not applied anywhere else. Otherwise what the driver
  -- collected for these goods would go to an older file in between.
  perform set_config('gs.hold_allocation', 'on', true);
  perform gs_cancel_consignment(p_consignment_id, p_user, p_reason);

  insert into consignments
    (shipment_id, customer_id, amount_due_usd_cents, other_charges_usd_cents, trust_at_time,
     status, cartons_expected, cartons_received, city, created_at)
  values
    (v_old.shipment_id, v_old.customer_id, p_amount_due_usd_cents, p_other_charges_usd_cents, v_old.trust_at_time,
     'listed', v_old.cartons_expected, v_old.cartons_received, v_old.city, v_old.created_at)
  returning id into v_new;

  update round_stops     set consignment_id = v_new where consignment_id = p_consignment_id;   -- results follow
  update attachments     set consignment_id = v_new where consignment_id = p_consignment_id;
  update exceptions      set consignment_id = v_new where consignment_id = p_consignment_id;
  update disputes        set consignment_id = v_new where consignment_id = p_consignment_id;
  update payment_targets set consignment_id = v_new where consignment_id = p_consignment_id;

  perform gs_charge_consignment(v_new, p_user, v_at);
  perform set_config('gs.hold_allocation', 'off', true);
  perform gs_allocate_customer(v_old.customer_id);
  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

-- Each round's cash per currency: what the receipts say was collected, what
-- was counted in, and the gap still on the round.
create view round_cash as
select a.round_id,
       a.currency,
       coalesce(sum(l.amount) filter (where coalesce(o.kind, e.kind) = 'driver_collected'), 0) as collected,
       -coalesce(sum(l.amount) filter (where coalesce(o.kind, e.kind) = 'round_handed_in'), 0) as handed_in,
       coalesce(sum(l.amount), 0) as gap
from accounts a
left join journal_lines l on l.account_id = a.id
left join journal_entries e on e.id = l.entry_id
left join journal_entries o on o.id = e.reverses_id
where a.kind = 'driver_cash'
group by a.round_id, a.currency;

-- Every stop of every round, as the round screen shows it.
create view round_stop_details as
select s.round_id,
       s.id as stop_id,
       s.seq,
       s.consignment_id,
       c.customer_id,
       cu.display_name as customer_name,
       cu.trust,
       sh.id as shipment_id,
       sh.code as shipment_code,
       c.city,
       c.status as consignment_status,
       c.cartons_expected,
       c.cartons_received,
       c.amount_due_usd_cents,
       cm.remaining_usd_cents,
       r.id as result_id,
       r.outcome,
       r.received_amount,
       r.received_currency,
       r.method,
       r.iqd_per_100_usd,
       r.credited_usd_cents,
       r.happened_at,
       exists (select 1 from attachments t where t.consignment_id = c.id and t.kind = 'payment_receipt') as has_payment_receipt,
       exists (select 1 from attachments t where t.consignment_id = c.id and t.kind = 'received_receipt') as has_received_receipt,
       exists (select 1 from attachments t where t.consignment_id = c.id and t.kind = 'carton_photo') as has_carton_photo,
       exists (select 1 from exceptions x where x.consignment_id = c.id) as has_exception
from round_stops s
join consignments c on c.id = s.consignment_id
join customers cu on cu.id = c.customer_id
join shipments sh on sh.id = c.shipment_id
join consignment_money cm on cm.consignment_id = c.id
left join round_results r
  on r.round_id = s.round_id and r.consignment_id = s.consignment_id and r.voided_at is null;

-- His top alert: a pay-first customer got the goods without paying in full
-- and nobody allowed it. The driver forgot to collect.
create view missed_collections as
select ls.round_id,
       rd.number as round_number,
       rd.driver_id,
       rd.carrier_id,
       c.id as consignment_id,
       c.customer_id,
       cu.display_name as customer_name,
       cm.due_usd_cents,
       cm.remaining_usd_cents as short_by_usd_cents,
       ls.happened_at
from consignment_last_stop ls
join rounds rd on rd.id = ls.round_id
join consignments c on c.id = ls.consignment_id
join customers cu on cu.id = c.customer_id
join consignment_money cm on cm.consignment_id = c.id
where c.status <> 'cancelled'
  and ls.outcome <> 'held'
  and ls.trust_at_time = 'pay_first'
  and cm.remaining_usd_cents > 0
  and not exists (select 1 from exceptions x where x.consignment_id = c.id);

-- Customers who were allowed to take goods without paying in full, until
-- they have paid.
create view chase_list as
select x.consignment_id,
       c.customer_id,
       cu.display_name as customer_name,
       cm.remaining_usd_cents,
       x.reason,
       x.approved_by,
       x.created_at as allowed_at
from exceptions x
join consignments c on c.id = x.consignment_id
join customers cu on cu.id = c.customer_id
join consignment_money cm on cm.consignment_id = c.id
where c.status <> 'cancelled' and cm.remaining_usd_cents > 0;

-- Cartons counted at the airport that do not match the file.
create view carton_mismatches as
select c.id as consignment_id,
       c.shipment_id,
       c.customer_id,
       c.cartons_expected,
       c.cartons_received,
       c.cartons_received - c.cartons_expected as difference
from consignments c
where c.status <> 'cancelled'
  and c.cartons_expected is not null and c.cartons_received is not null
  and c.cartons_received <> c.cartons_expected;

-- Goods held in the delivery car, and since when.
create view held_in_car as
select c.id as consignment_id,
       c.customer_id,
       c.shipment_id,
       ls.round_id,
       (select min(r.happened_at) from round_results r
        where r.consignment_id = c.id and r.voided_at is null and r.outcome = 'held') as held_since
from consignments c
join consignment_last_stop ls on ls.consignment_id = c.id
where c.status = 'held';

-- One line per round for the rounds list and the Today screen.
create view round_overview as
select rd.id as round_id,
       rd.number,
       rd.status,
       rd.driver_id,
       d.name as driver_name,
       rd.carrier_id,
       k.name as carrier_name,
       rd.left_at,
       rd.returned_at,
       rd.handed_in_at,
       (select count(*) from round_stops s join consignments c on c.id = s.consignment_id
        where s.round_id = rd.id and c.status <> 'cancelled') as stops,
       (select count(*) from round_results r where r.round_id = rd.id and r.voided_at is null) as results,
       (select count(*) from missed_collections m where m.round_id = rd.id) as missed_collections,
       coalesce((select rc.collected from round_cash rc where rc.round_id = rd.id and rc.currency = 'USD'), 0) as collected_usd_cents,
       coalesce((select rc.collected from round_cash rc where rc.round_id = rd.id and rc.currency = 'IQD'), 0) as collected_iqd,
       coalesce((select rc.gap from round_cash rc where rc.round_id = rd.id and rc.currency = 'USD'), 0) as gap_usd_cents,
       coalesce((select rc.gap from round_cash rc where rc.round_id = rd.id and rc.currency = 'IQD'), 0) as gap_iqd
from rounds rd
left join drivers d on d.id = rd.driver_id
left join carriers k on k.id = rd.carrier_id;

-- ---------------------------------------------------------------------------
-- Health check, now covering rounds
-- ---------------------------------------------------------------------------

create function gs_rounds_health() returns table (problem text, detail text)
language sql stable as $$
  select 'collection_without_result', e.id::text
  from journal_entries e
  where e.kind = 'driver_collected'
    and not exists (select 1 from round_results r where r.payment_entry_id = e.id)
  union all
  select 'result_payment_reversed', r.id::text
  from round_results r
  where r.voided_at is null and r.payment_entry_id is not null
    and exists (select 1 from journal_entries x where x.reverses_id = r.payment_entry_id)
  union all
  select 'voided_result_payment_stands', r.id::text
  from round_results r
  where r.voided_at is not null and r.payment_entry_id is not null
    and not exists (select 1 from journal_entries x where x.reverses_id = r.payment_entry_id)
  union all
  select 'hand_in_without_record', e.id::text
  from journal_entries e
  where e.kind = 'round_handed_in'
    and not exists (select 1 from round_hand_ins h where h.entry_id = e.id)
  union all
  select 'consignment_on_two_rounds', s.consignment_id::text
  from round_stops s
  where not exists (select 1 from round_results r
                    where r.round_id = s.round_id and r.consignment_id = s.consignment_id and r.voided_at is null)
  group by s.consignment_id having count(*) > 1
  union all
  select 'consignment_status_stale', c.id::text || ' is ' || c.status::text || ', facts say ' || gs_derived_consignment_status(c.id)::text
  from consignments c join shipments s on s.id = c.shipment_id
  where s.status <> 'draft' and c.status <> 'cancelled'
    and c.status is distinct from gs_derived_consignment_status(c.id)
  union all
  select 'shipment_status_stale', s.id::text || ' is ' || s.status::text || ', facts say ' || gs_derived_shipment_status(s.id)::text
  from shipments s
  where s.status <> 'draft' and s.status is distinct from gs_derived_shipment_status(s.id)
  union all
  select 'round_cash_not_driver_money', a.round_id::text || ' ' || a.currency::text
  from accounts a join journal_lines l on l.account_id = a.id
  join journal_entries e on e.id = l.entry_id
  left join journal_entries o on o.id = e.reverses_id
  where a.kind = 'driver_cash' and coalesce(o.kind, e.kind) not in ('driver_collected', 'round_handed_in')
  group by a.round_id, a.currency;
$$;

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
    and exists (select 1 from customer_payments p where p.customer_id = c.id and p.credit_usd_cents > p.allocated_usd_cents)
  union all
  select * from gs_rounds_health();
$$;

-- ---------------------------------------------------------------------------
-- The application's role
-- ---------------------------------------------------------------------------

-- Status is worked out, not typed in: the app can no longer set it.
revoke insert (status), update (status) on consignments from green_star_app;
revoke update (status) on shipments from green_star_app;

grant select on drivers, carriers, rounds, round_stops, round_results, attachments, exceptions,
                cash_denominations, round_hand_ins, cash_counts, payment_targets,
                consignment_last_stop, round_cash, round_stop_details, missed_collections,
                chase_list, carton_mismatches, held_in_car, round_overview
  to green_star_app;

grant insert, update on drivers, carriers to green_star_app;
-- Status and the times are not in this list: they move through the functions above.
grant insert (id, driver_id, carrier_id, note, created_by), update (driver_id, carrier_id, note)
  on rounds to green_star_app;
grant usage on sequence rounds_number_seq to green_star_app;
grant insert, delete on attachments to green_star_app;
grant insert on exceptions to green_star_app;
