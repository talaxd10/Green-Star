-- At the door, a customer often pays in more than one way: "$400 and the rest
-- in dinars", or part in cash and part by FIB. A round result now takes every
-- part of what he handed over, and dinars are rounded at the door the same
-- way as at the office.
--
-- What the database guarantees here:
--   1. One stop has one result, as before. Its first payment is on the result
--      itself; the rest of what he handed over is in round_result_parts.
--   2. Each part is its own ledger entry: one amount, one currency, one way of
--      paying. The driver's dollars and dinars each go to the round's cash in
--      that currency, a wallet part goes to the wallet.
--   3. Dollars are applied first, then dinars in the order given, so it is the
--      dinars that settle what is left and take the rounding.
--   4. Taking a result back, or entering the stop again, reverses every part.
--   5. A part is never edited or deleted.

-- ---------------------------------------------------------------------------
-- The rest of what he handed over
-- ---------------------------------------------------------------------------

create table round_result_parts (
  result_id          uuid not null references round_results (id),
  part_no            smallint not null,           -- 2, 3, 4: the first payment is on the result
  received_amount    bigint not null,
  received_currency  currency not null,
  method             payment_method not null,
  iqd_per_100_usd    integer,                     -- the day's rate, when dinars were received
  credited_usd_cents bigint not null,             -- what it was worth on the customer's account
  payment_entry_id   uuid not null references journal_entries (id),
  primary key (result_id, part_no),
  constraint round_result_parts_numbered check (part_no between 2 and 4),
  constraint round_result_parts_amount_positive check (received_amount > 0),
  constraint round_result_parts_method check (method <> 'office_cash'),
  constraint round_result_parts_rate_with_dinars check ((received_currency = 'IQD') = (iqd_per_100_usd is not null))
);

create unique index round_result_parts_payment_entry on round_result_parts (payment_entry_id);

create trigger round_result_parts_no_change before update or delete on round_result_parts
  for each row execute function gs_forbid_change();
create trigger round_result_parts_no_truncate before truncate on round_result_parts
  for each statement execute function gs_forbid_change();

-- Every payment a round result posted, first part and the rest, in one list.
create view round_payment_entries as
select r.payment_entry_id as entry_id,
       r.id as result_id,
       r.round_id,
       r.consignment_id,
       1::smallint as part_no,
       r.received_amount,
       r.received_currency,
       r.method,
       r.iqd_per_100_usd,
       r.credited_usd_cents,
       r.voided_at is not null as voided
from round_results r
where r.payment_entry_id is not null
union all
select p.payment_entry_id,
       r.id,
       r.round_id,
       r.consignment_id,
       p.part_no,
       p.received_amount,
       p.received_currency,
       p.method,
       p.iqd_per_100_usd,
       p.credited_usd_cents,
       r.voided_at is not null
from round_result_parts p
join round_results r on r.id = p.result_id;

-- ---------------------------------------------------------------------------
-- Entering a result
-- ---------------------------------------------------------------------------

-- Voids one result and reverses every payment it posted. Internal: callers
-- hold the round and customer locks.
create or replace function gs_void_result_inner(p_result_id uuid, p_user uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res  round_results%rowtype;
  v_part record;
begin
  select * into v_res from round_results where id = p_result_id for update;
  if v_res.voided_at is not null then
    return;
  end if;
  -- The last one in is the first one out, so the account passes through the
  -- same balances on the way back.
  for v_part in
    select entry_id, part_no from round_payment_entries where result_id = p_result_id order by part_no desc
  loop
    if not exists (select 1 from journal_entries r where r.reverses_id = v_part.entry_id) then
      perform gs_reverse_entry(
        v_part.entry_id, p_user, p_reason,
        'void_result:' || p_result_id::text || case when v_part.part_no = 1 then '' else ':' || v_part.part_no end);
    end if;
  end loop;
  update round_results
     set voided_at = now(), voided_by = p_user, void_reason = btrim(p_reason)
   where id = p_result_id;
end $$;

drop function gs_enter_round_result(uuid, uuid, uuid, round_outcome, uuid, timestamptz, bigint, currency, payment_method, text);

-- What happened at one stop. Entering a result for a stop that already has
-- one replaces it: the old payments are reversed and the new ones posted.
--
-- paid        goods handed over and money received (or already paid before)
-- on_account  goods handed over to a trusted customer; what is unpaid goes on his account
-- prepaid     goods handed over, nothing to collect ($0 on the file)
-- held        goods stay in the car; no money
-- unpaid      goods handed over to a pay-first customer who did not pay in full
--
-- p_more is the rest of what he handed over when he paid in more than one
-- way: [{"amount": 209000, "currency": "IQD", "method": "driver_cash"}, ...].
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
  p_note              text default null,
  p_more              jsonb default null
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
  v_balance  bigint;
  v_current  uuid;
  v_rate     integer;
  v_cents    bigint;
  v_into     uuid;
  v_entry    uuid;
  v_kind     entry_kind;
  v_cust_acc uuid;
  v_parts    jsonb := '[]'::jsonb;
  v_part     record;
  v_amount   bigint;
  v_currency currency;
  v_method   payment_method;
  v_no       integer := 0;
  v_posted   jsonb := '[]'::jsonb;
  v_first    jsonb;
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
    if p_received_currency is null or p_method is null then
      raise exception 'payment_incomplete: an amount needs its currency and method' using errcode = 'P0001';
    end if;
    v_parts := jsonb_build_array(
      jsonb_build_object('amount', p_received_amount, 'currency', p_received_currency, 'method', p_method));
  end if;

  -- Every part of what he handed over, checked the same way.
  if p_more is not null and p_more <> 'null'::jsonb then
    if jsonb_typeof(p_more) <> 'array' then
      raise exception 'payment_incomplete: the other payments must be a list' using errcode = 'P0001';
    end if;
    if jsonb_array_length(p_more) > 0 then
      if p_received_amount is null then
        raise exception 'payment_incomplete: other payments were given without a first one' using errcode = 'P0001';
      end if;
      v_parts := v_parts || p_more;
    end if;
  end if;
  if jsonb_array_length(v_parts) > 4 then
    raise exception 'payment_invalid: one stop takes at most four payments' using errcode = 'P0001';
  end if;
  for v_part in select value from jsonb_array_elements(v_parts) loop
    if jsonb_typeof(v_part.value) <> 'object'
       or (v_part.value ->> 'amount') is null or (v_part.value ->> 'currency') is null or (v_part.value ->> 'method') is null then
      raise exception 'payment_incomplete: an amount needs its currency and method' using errcode = 'P0001';
    end if;
    if (v_part.value ->> 'amount') !~ '^[0-9]{1,15}$' or (v_part.value ->> 'amount')::bigint <= 0 then
      raise exception 'amount_invalid: the amount received must be more than zero' using errcode = 'P0001';
    end if;
    if (v_part.value ->> 'currency') not in ('USD', 'IQD') then
      raise exception 'payment_invalid: money is taken in dollars or dinars' using errcode = 'P0001';
    end if;
    if (v_part.value ->> 'method') not in ('driver_cash', 'fib', 'fastpay', 'zaincash') then
      raise exception 'method_invalid: money taken on a round is driver cash or a wallet' using errcode = 'P0001';
    end if;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(v_parts) as t (value)
    group by value ->> 'currency', value ->> 'method' having count(*) > 1
  ) then
    raise exception 'payment_invalid: two payments in the same currency and the same way are one payment. Add them up.'
      using errcode = 'P0001';
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

  -- Dollars first, then dinars, each in the order given.
  if jsonb_array_length(v_parts) > 0 then
    v_cust_acc := gs_customer_account(v_customer, v_name);
  end if;
  for v_part in
    select t.value from jsonb_array_elements(v_parts) with ordinality as t (value, n)
    order by (t.value ->> 'currency') = 'IQD', t.n
  loop
    v_no := v_no + 1;
    v_amount := (v_part.value ->> 'amount')::bigint;
    v_currency := (v_part.value ->> 'currency')::currency;
    v_method := (v_part.value ->> 'method')::payment_method;
    v_rate := null;

    if v_method = 'driver_cash' then
      v_kind := 'driver_collected';
      v_into := gs_driver_cash_account(p_round_id, v_currency, 'Round ' || v_round.number || ' cash, ' || v_currency);
    else
      v_kind := 'wallet_payment';
      v_into := gs_account('wallet_' || v_method::text || '_' || lower(v_currency::text));
    end if;

    if v_currency = 'USD' then
      v_cents := v_amount;
      v_entry := gs_post_entry(
        v_kind, p_happened_at, p_user, 'round_result:' || p_id::text || case when v_no = 1 then '' else ':' || v_no end,
        jsonb_build_array(
          jsonb_build_object('account_id', v_into, 'currency', 'USD', 'amount', v_amount),
          jsonb_build_object('account_id', v_cust_acc, 'currency', 'USD', 'amount', -v_amount)),
        null, null, null, p_consignment_id);
    else
      v_rate := gs_day_rate(p_happened_at);
      if gs_iqd_to_usd_cents(v_amount, v_rate) <= 0 then
        raise exception 'amount_invalid: % IQD is worth less than a cent', v_amount using errcode = 'P0001';
      end if;
      -- What is still owed now, after the parts before this one: on these
      -- goods first, then on everything.
      select remaining_usd_cents into v_remaining from consignment_money where consignment_id = p_consignment_id;
      select balance_usd_cents into v_balance from customer_balances where customer_id = v_customer;
      v_cents := gs_dinar_credit(v_amount, v_rate, v_remaining, v_balance);
      v_entry := gs_post_entry(
        v_kind, p_happened_at, p_user, 'round_result:' || p_id::text || case when v_no = 1 then '' else ':' || v_no end,
        gs_dinar_payment_lines(v_into, v_cust_acc, v_amount, v_rate, v_cents),
        null, v_rate, null, p_consignment_id);
    end if;

    v_posted := v_posted || jsonb_build_array(jsonb_build_object(
      'no', v_no, 'amount', v_amount, 'currency', v_currency, 'method', v_method,
      'rate', v_rate, 'cents', v_cents, 'entry', v_entry));
  end loop;

  v_first := v_posted -> 0;
  insert into round_results
    (id, round_id, consignment_id, outcome, trust_at_time, received_amount, received_currency, method,
     iqd_per_100_usd, credited_usd_cents, happened_at, payment_entry_id, note, entered_by)
  values
    (p_id, p_round_id, p_consignment_id, p_outcome, v_trust,
     (v_first ->> 'amount')::bigint, (v_first ->> 'currency')::currency, (v_first ->> 'method')::payment_method,
     (v_first ->> 'rate')::integer, (v_first ->> 'cents')::bigint, p_happened_at, (v_first ->> 'entry')::uuid,
     nullif(btrim(p_note), ''), p_user);

  insert into round_result_parts
    (result_id, part_no, received_amount, received_currency, method, iqd_per_100_usd, credited_usd_cents, payment_entry_id)
  select p_id, (x ->> 'no')::smallint, (x ->> 'amount')::bigint, (x ->> 'currency')::currency, (x ->> 'method')::payment_method,
         (x ->> 'rate')::integer, (x ->> 'cents')::bigint, (x ->> 'entry')::uuid
  from jsonb_array_elements(v_posted) as x
  where (x ->> 'no')::integer > 1;

  if v_round.status = 'out' then
    update rounds set status = 'returned', returned_at = now() where id = p_round_id;
  end if;

  perform gs_refresh_customer(v_customer);
  return p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Everything that asked "is this a round's payment?" now asks about every part
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
       or exists (select 1 from round_payment_entries r where r.entry_id = new.reverses_id) then
      raise exception 'round_money_needs_round: change the round result instead of reversing its payment'
        using errcode = 'P0001';
    end if;
    if v_kind = 'round_handed_in' then
      raise exception 'round_money_needs_round: a hand-in is undone by gs_void_hand_in' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

create or replace function gs_rounds_health() returns table (problem text, detail text)
language sql stable as $$
  select 'collection_without_result', e.id::text
  from journal_entries e
  where e.kind = 'driver_collected'
    and not exists (select 1 from round_payment_entries r where r.entry_id = e.id)
  union all
  select 'result_payment_reversed', r.result_id::text
  from round_payment_entries r
  where not r.voided
    and exists (select 1 from journal_entries x where x.reverses_id = r.entry_id)
  union all
  select 'voided_result_payment_stands', r.result_id::text
  from round_payment_entries r
  where r.voided
    and not exists (select 1 from journal_entries x where x.reverses_id = r.entry_id)
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

-- A customer's account line by line, as before: a payment taken on a round
-- says which round, whichever part of the result it was.
create or replace view customer_account_lines as
select a.customer_id,
       l.id as line_id,
       e.id as entry_id,
       coalesce(o.kind, e.kind) as what,          -- file_confirmed, driver_collected, office_payment, wallet_payment, error_correction
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
       coalesce(p.round_id, (select rp.round_id from round_payment_entries rp where rp.entry_id = p.entry_id)) as round_id
from journal_lines l
join accounts a on a.id = l.account_id and a.kind = 'customer'
join journal_entries e on e.id = l.entry_id
left join journal_entries o on o.id = e.reverses_id
left join consignments c on c.charge_entry_id = coalesce(e.reverses_id, e.id)
left join shipments s on s.id = c.shipment_id
left join payments p on p.entry_id = coalesce(e.reverses_id, e.id);

-- Every stop of every round, as the round screen shows it. The last column
-- is new: every part of what he handed over, in the order it was applied.
create or replace view round_stop_details as
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
       exists (select 1 from exceptions x where x.consignment_id = c.id) as has_exception,
       coalesce((
         select jsonb_agg(jsonb_build_object(
                  'received_amount', rp.received_amount,
                  'received_currency', rp.received_currency,
                  'method', rp.method,
                  'iqd_per_100_usd', rp.iqd_per_100_usd,
                  'credited_usd_cents', rp.credited_usd_cents) order by rp.part_no)
         from round_payment_entries rp where rp.result_id = r.id), '[]'::jsonb) as payments
from round_stops s
join consignments c on c.id = s.consignment_id
join customers cu on cu.id = c.customer_id
join shipments sh on sh.id = c.shipment_id
join consignment_money cm on cm.consignment_id = c.id
left join round_results r
  on r.round_id = s.round_id and r.consignment_id = s.consignment_id and r.voided_at is null;

grant select on round_result_parts, round_payment_entries to green_star_app;
