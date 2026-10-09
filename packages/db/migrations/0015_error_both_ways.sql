-- The Error entry goes both ways and has no limit.
--
-- The CEO, October 2026: "error entry is for both and no limit, this is just
-- to make San's job easier." Before this an Error entry could only take off
-- what a customer owes, at most $5 (a setting).
--
-- What the database guarantees now:
--   1. An Error entry takes an amount off what one customer owes, or adds an
--      amount to it. There is no limit, and no setting for one.
--   2. Taking off never goes below nothing. Credit is money that came in;
--      an Error entry is not money.
--   3. Adding goes onto one of his consignments. Everything a customer owes
--      still belongs to a file: the consignment is owed more, payments pay it
--      the usual way, and the ledger's health check still adds up.
--   4. A consignment with an Error added to it is not cancelled on its own.
--      The Error entry is reversed first. Correcting the amount carries it
--      over to the replacement.
--   5. An Error entry is reversed like any other entry. When one that added
--      was already paid, the money that paid it is applied again: to the
--      oldest unpaid consignment, or it stays as credit.

-- ---------------------------------------------------------------------------
-- No limit
-- ---------------------------------------------------------------------------

alter table settings drop column error_max_usd_cents;

-- ---------------------------------------------------------------------------
-- Both ways
-- ---------------------------------------------------------------------------

alter table entry_shapes disable trigger entry_shapes_no_change;
update entry_shapes set direction = 0 where entry_kind = 'error_correction';
alter table entry_shapes enable trigger entry_shapes_no_change;

-- An entry says which consignment it is for while it is posted. A payment or
-- an Error that takes off pays that one first; an Error that adds goes onto it.
create or replace function gs_set_payment_target(p_entry_id uuid, p_consignment_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from journal_entries e where e.id = p_entry_id and e.created_at = now()) then
    raise exception 'entry_closed: a payment says what it is for only while it is being posted' using errcode = 'P0001';
  end if;
  if not exists (
    select 1
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id and a.kind = 'customer'
    join consignments c on c.customer_id = a.customer_id
    where l.entry_id = p_entry_id and c.id = p_consignment_id
      and (l.amount < 0 or e.kind = 'error_correction')
  ) then
    raise exception 'target_invalid: a payment can only be made for a consignment of the customer it credits'
      using errcode = 'P0001';
  end if;
  insert into payment_targets (entry_id, consignment_id) values (p_entry_id, p_consignment_id);
end $$;

-- What an Error entry added to each consignment, while it stands.
create view consignment_errors_added as
select t.consignment_id,
       sum(l.amount)::bigint as added_usd_cents
from payment_targets t
join journal_entries e on e.id = t.entry_id and e.kind = 'error_correction'
join journal_lines l on l.entry_id = e.id
join accounts a on a.id = l.account_id and a.kind = 'customer'
where l.amount > 0
  and not exists (select 1 from journal_entries r where r.reverses_id = e.id)
group by t.consignment_id;

-- What each consignment is owed, now with what an Error entry added to it.
create or replace view consignment_money as
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
                + coalesce((select x.added_usd_cents from consignment_errors_added x where x.consignment_id = c.id), 0)
           else 0
         end as due_usd_cents
) d
left join lateral (
  select sum(ea.amount_usd_cents) as paid from effective_allocations ea where ea.consignment_id = c.id
) p on true;

-- Payments and Error entries that take off. An Error that adds is owed, not paid.
create or replace view customer_payments as
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
where e.kind in ('driver_collected', 'office_payment', 'wallet_payment', 'error_correction')
  and not exists (select 1 from journal_entries r where r.reverses_id = e.id)
group by e.id, a.customer_id, e.kind, e.happened_at, e.created_at
having e.kind <> 'error_correction' or -sum(l.amount) > 0;

-- Every Error entry, for the Money screen. amount is always positive; added
-- says which way it went.
create or replace view error_entries as
select e.id as entry_id,
       a.customer_id,
       cu.display_name as customer_name,
       abs(l.amount) as amount_usd_cents,
       e.happened_at,
       e.created_at,
       e.created_by,
       e.reason as note,
       exists (select 1 from journal_entries r where r.reverses_id = e.id) as reversed,
       l.amount > 0 as added,
       t.consignment_id
from journal_entries e
join journal_lines l on l.entry_id = e.id
join accounts a on a.id = l.account_id and a.kind = 'customer'
join customers cu on cu.id = a.customer_id
left join payment_targets t on t.entry_id = e.id
where e.kind = 'error_correction';

-- A consignment's page shows what an Error added to it.
create or replace view consignment_details as
select c.id as consignment_id,
       c.shipment_id,
       s.code as shipment_code,
       s.status as shipment_status,
       s.confirmed_at,
       c.customer_id,
       cu.display_name as customer_name,
       cu.trust,
       c.status,
       c.amount_due_usd_cents,
       c.other_charges_usd_cents,
       cm.paid_usd_cents,
       cm.remaining_usd_cents,
       c.cartons_expected,
       c.cartons_received,
       c.city,
       c.created_at,
       ls.round_id as last_round_id,
       exists (select 1 from exceptions x where x.consignment_id = c.id) as has_exception,
       cm.due_usd_cents - case when cm.due_usd_cents = 0 then 0 else c.amount_due_usd_cents end as errors_added_usd_cents
from consignments c
join shipments s on s.id = c.shipment_id
join customers cu on cu.id = c.customer_id
join consignment_money cm on cm.consignment_id = c.id
left join consignment_last_stop ls on ls.consignment_id = c.id;


grant select on consignment_errors_added to green_star_app;


-- ---------------------------------------------------------------------------
-- Money given back when a consignment is owed less
-- ---------------------------------------------------------------------------

-- An allocation is never edited. When a consignment comes to be owed less
-- than was applied to it, part of an allocation is given back here and the
-- money is applied again, oldest unpaid first, or stays as credit.
create table allocation_releases (
  id               bigint generated always as identity primary key,
  allocation_id    bigint not null references allocations (id),
  amount_usd_cents bigint not null,
  created_at       timestamptz not null default now(),
  constraint allocation_releases_amount_positive check (amount_usd_cents > 0)
);

create index allocation_releases_allocation on allocation_releases (allocation_id);

create trigger allocation_releases_no_change before update or delete on allocation_releases
  for each row execute function gs_forbid_change();
create trigger allocation_releases_no_truncate before truncate on allocation_releases
  for each statement execute function gs_forbid_change();

create or replace view effective_allocations as
select al.id, al.entry_id, al.consignment_id,
       al.amount_usd_cents - coalesce(r.released, 0) as amount_usd_cents,
       al.created_at
from allocations al
join consignments c on c.id = al.consignment_id
left join lateral (
  select sum(x.amount_usd_cents)::bigint as released from allocation_releases x where x.allocation_id = al.id
) r on true
where c.status <> 'cancelled'
  and c.charge_entry_id is not null
  and al.amount_usd_cents > coalesce(r.released, 0)
  and not exists (select 1 from journal_entries r where r.reverses_id = al.entry_id)
  and not exists (select 1 from journal_entries r where r.reverses_id = c.charge_entry_id);

grant select on allocation_releases to green_star_app;

-- Same as before, and money applied to a consignment that is now owed less is given back first.
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

  -- A consignment that is now owed less than was applied to it (an Error
  -- that added to it was reversed) gives the difference back, newest money
  -- first. What is given back is applied again below, like any credit.
  for v_con in
    select cm.consignment_id, cm.paid_usd_cents - cm.due_usd_cents as excess
    from consignment_money cm
    where cm.customer_id = p_customer_id and cm.paid_usd_cents > cm.due_usd_cents
  loop
    v_left := v_con.excess;
    for v_pay in
      select ea.id, ea.amount_usd_cents from effective_allocations ea
      where ea.consignment_id = v_con.consignment_id
      order by ea.created_at desc, ea.id desc
    loop
      exit when v_left = 0;
      v_take := least(v_left, v_pay.amount_usd_cents);
      insert into allocation_releases (allocation_id, amount_usd_cents) values (v_pay.id, v_take);
      v_left := v_left - v_take;
    end loop;
  end loop;

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
-- ---------------------------------------------------------------------------
-- The ledger's own check, with the new Error rule
-- ---------------------------------------------------------------------------

create or replace function gs_check_entry_complete() returns trigger
language plpgsql as $$
declare
  v_lines      integer;
  v_clear_usd  bigint;
  v_clear_iqd  bigint;
  v_day_rate   integer;
  v_orig       journal_entries%rowtype;
  v_rounding   bigint;
  v_credit     bigint;
  v_customer   uuid;
  v_balance    bigint;
  v_target     uuid;
  v_remaining  bigint;
begin
  select count(*) into v_lines from journal_lines where entry_id = new.id;
  if v_lines < 2 then
    raise exception 'entry_incomplete: entry % has % line(s); an entry needs at least two', new.id, v_lines
      using errcode = 'P0001';
  end if;

  -- Conversions pass through the exchange clearing accounts. When they are
  -- touched, the entry must carry a rate and the two legs must agree with it
  -- to within half a cent.
  select coalesce(sum(l.amount) filter (where l.currency = 'USD'), 0),
         coalesce(sum(l.amount) filter (where l.currency = 'IQD'), 0)
    into v_clear_usd, v_clear_iqd
  from journal_lines l
  join accounts a on a.id = l.account_id
  where l.entry_id = new.id and a.kind = 'exchange_clearing';

  if v_clear_usd <> 0 or v_clear_iqd <> 0 then
    if new.iqd_per_100_usd is null then
      raise exception 'rate_missing: entry % converts between currencies but has no rate', new.id
        using errcode = 'P0001';
    end if;
    if v_clear_usd = 0 or v_clear_iqd = 0 or sign(v_clear_usd) = sign(v_clear_iqd) then
      raise exception 'conversion_invalid: entry % has a one-sided conversion', new.id
        using errcode = 'P0001';
    end if;

    -- Customer payments in dinars convert at the day's rate, not a typed one,
    -- and the dinars pass through the clearing accounts at what they are
    -- worth at that rate.
    -- (A currency exchange records the two amounts that really changed hands,
    -- so only its rate is required, not this arithmetic.)
    if new.kind in ('driver_collected', 'office_payment', 'wallet_payment') then
      select iqd_per_100_usd into v_day_rate
      from fx_rates
      where day = (new.happened_at at time zone 'Asia/Baghdad')::date;
      if v_day_rate is null then
        raise exception 'rate_missing: set the dinar rate for % first',
          (new.happened_at at time zone 'Asia/Baghdad')::date
          using errcode = 'P0001';
      end if;
      if v_day_rate <> new.iqd_per_100_usd then
        raise exception 'rate_mismatch: the rate for % is %, the entry used %',
          (new.happened_at at time zone 'Asia/Baghdad')::date, v_day_rate, new.iqd_per_100_usd
          using errcode = 'P0001';
      end if;
      if 2 * abs(abs(v_clear_iqd) * 10000 - abs(v_clear_usd) * new.iqd_per_100_usd) > new.iqd_per_100_usd then
        raise exception 'conversion_mismatch: % IQD is not % cents at % IQD per 100 USD',
          abs(v_clear_iqd), abs(v_clear_usd), new.iqd_per_100_usd
          using errcode = 'P0001';
      end if;
    end if;
  elsif new.iqd_per_100_usd is not null and new.reverses_id is null then
    raise exception 'rate_unused: entry % carries a rate but converts nothing', new.id
      using errcode = 'P0001';
  end if;

  -- A payment whose customer is credited something else than the dinars
  -- convert to carries the difference on the rounding account. That is
  -- allowed in one case only: dinars that settle what is owed, give or take
  -- half the rounding step.
  if new.kind in ('driver_collected', 'office_payment', 'wallet_payment') then
    select coalesce(sum(l.amount), 0) into v_rounding
    from journal_lines l join accounts a on a.id = l.account_id
    where l.entry_id = new.id and a.kind = 'adjustment';

    if v_rounding <> 0 then
      if v_clear_iqd = 0 then
        raise exception 'rounding_invalid: only a payment in dinars is rounded' using errcode = 'P0001';
      end if;
      select a.customer_id, -sum(l.amount) into v_customer, v_credit
      from journal_lines l join accounts a on a.id = l.account_id
      where l.entry_id = new.id and a.kind = 'customer'
      group by a.customer_id;
      if v_credit is null or v_credit <= 0 then
        raise exception 'rounding_invalid: a rounded payment credits a customer' using errcode = 'P0001';
      end if;
      if not gs_dinars_settle(abs(v_clear_iqd), new.iqd_per_100_usd, v_credit) then
        raise exception 'rounding_too_large: % IQD is not % at today''s rate, even rounded to the nearest %',
          abs(v_clear_iqd), gs_money_text(v_credit, 'USD'::currency), (select dinar_rounding_iqd from settings)
          using errcode = 'P0001';
      end if;

      -- What he owed before this entry: this entry's own line is already on his balance.
      select balance_usd_cents + v_credit into v_balance from customer_balances where customer_id = v_customer;
      select t.consignment_id into v_target from payment_targets t where t.entry_id = new.id;
      if v_target is not null then
        select cm.remaining_usd_cents
               + coalesce((select sum(ea.amount_usd_cents) from effective_allocations ea
                           where ea.entry_id = new.id and ea.consignment_id = v_target), 0)
          into v_remaining
        from consignment_money cm where cm.consignment_id = v_target;
      end if;
      if v_credit is distinct from v_balance and v_credit is distinct from v_remaining then
        raise exception 'rounding_invalid: dinars are rounded only when they settle what is owed' using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- An Error entry: an amount off what one customer owes, or onto it. No
  -- limit (the CEO, October 2026). Taking off never goes below nothing:
  -- that would be credit for money that never came. Adding goes onto one
  -- of his consignments, so everything he owes still belongs to a file.
  if new.kind = 'error_correction' then
    select a.customer_id, -sum(l.amount) into v_customer, v_credit
    from journal_lines l join accounts a on a.id = l.account_id
    where l.entry_id = new.id and a.kind = 'customer'
    group by a.customer_id;
    if v_credit is null or v_credit = 0 then
      raise exception 'error_invalid: an Error entry changes what one customer owes' using errcode = 'P0001';
    end if;
    if v_credit > 0 then
      select balance_usd_cents into v_balance from customer_balances where customer_id = v_customer;
      if v_balance < 0 then
        raise exception 'error_more_than_owed: he owes %, so an Error entry cannot take off %',
          gs_money_text(greatest(v_balance + v_credit, 0), 'USD'::currency), gs_money_text(v_credit, 'USD'::currency)
          using errcode = 'P0001';
      end if;
    else
      select t.consignment_id into v_target from payment_targets t where t.entry_id = new.id;
      if v_target is null or not exists (
           select 1 from consignments c
           where c.id = v_target and c.customer_id = v_customer and c.status <> 'cancelled'
             and c.charge_entry_id is not null
             and not exists (select 1 from journal_entries r where r.reverses_id = c.charge_entry_id)) then
        raise exception 'error_needs_consignment: an Error entry that adds to what he owes goes on one of his consignments'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  if new.reverses_id is not null then
    select * into v_orig from journal_entries where id = new.reverses_id;
    if v_orig.reverses_id is not null then
      raise exception 'reversal_invalid: a reversal cannot be reversed. Post a new entry instead.'
        using errcode = 'P0001';
    end if;
    if new.iqd_per_100_usd is distinct from v_orig.iqd_per_100_usd then
      raise exception 'reversal_invalid: a reversal keeps the rate of the entry it reverses'
        using errcode = 'P0001';
    end if;
    if exists (
      select 1
      from (select account_id, currency, sum(amount) as amt from journal_lines
            where entry_id = new.id group by account_id, currency) r
      full join
           (select account_id, currency, sum(amount) as amt from journal_lines
            where entry_id = new.reverses_id group by account_id, currency) o
        using (account_id, currency)
      where coalesce(r.amt, 0) + coalesce(o.amt, 0) <> 0
    ) then
      raise exception 'reversal_invalid: entry % is not the exact mirror of %', new.id, new.reverses_id
        using errcode = 'P0001';
    end if;
  end if;

  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Cancelling a consignment an Error was added to
-- ---------------------------------------------------------------------------

-- Same as before, and a consignment an Error entry added to is not cancelled
-- on its own: what was added would be owed on no file. Correcting it is
-- fine; the replacement takes the Error over.
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
  if coalesce(current_setting('gs.hold_allocation', true), '') <> 'on'
     and exists (select 1 from consignment_errors_added x where x.consignment_id = p_consignment_id) then
    raise exception 'consignment_has_error: an Error entry added to this consignment. Reverse it first.'
      using errcode = 'P0001';
  end if;
  if v_con.charge_entry_id is not null
     and not exists (select 1 from journal_entries r where r.reverses_id = v_con.charge_entry_id) then
    perform gs_reverse_entry(v_con.charge_entry_id, p_user, p_reason, 'cancel:' || p_consignment_id::text);
  end if;
  update consignments set status = 'cancelled' where id = p_consignment_id;
  perform gs_allocate_customer(v_con.customer_id);
end $$;
