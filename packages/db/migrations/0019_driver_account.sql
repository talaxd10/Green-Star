-- The driver's own account, his receipts, and the change he gives at the door.
--
-- The CEO, October 2026: "When the driver starts delivering goods, before he
-- leaves San gives him 500,000 IQD for example. Then any money he spends for
-- gas, car parts, workers, anything he spends on that, we want to have a
-- driver account. Every time he leaves to deliver, add the money to his
-- account; when he comes back with the receipts, San enters it." And: "A
-- customer's goods are $490, he pays $500 to the driver, the driver pays the
-- remaining $10 in IQD to him, for example 15,000 IQD. That 15,000 is also
-- taken from the driver's account."
--
-- What the database guarantees here:
--   1. Each driver has his own account, per currency: the money of the
--      office's that he holds to spend on the road. It is not a round's cash:
--      what he collects from customers is still counted in round by round.
--   2. Money reaches it only from the vault (he is given it), and leaves it
--      only as a receipt (an expense of a kind), as change at a door, or back
--      to the vault. Nothing else can move it.
--   3. Every receipt says what kind of expense it was. A city and the round it
--      was for can be added, so the delivery costs can be counted exactly.
--   4. Change at the door is part of the customer's payment, not an expense:
--      he is credited what his dollars came to less the dinars given back, at
--      the day's rate, and the dinars come off the round driver's account. A
--      change that comes to what he owes, give or take half the rounding step,
--      settles it; the difference is on the Dinar rounding account.
--   5. An expense paid from the vault can say the same: what kind, which city,
--      which round.
--   6. Nothing is edited. A wrong receipt is reversed and entered again.

-- ---------------------------------------------------------------------------
-- The kinds of expense
-- ---------------------------------------------------------------------------

create table expense_categories (
  code     text primary key,
  label    text not null,
  delivery boolean not null,   -- a cost of getting goods to customers
  sort     smallint not null unique
);

insert into expense_categories (code, label, delivery, sort) values
  ('fuel_car',        'Fuel',                              true,  1),
  ('car_parts',       'Car parts and repairs',             true,  2),
  ('workers',         'Workers and loading',               true,  3),
  ('transport',       'Transport company between cities',  true,  4),
  ('driver_pay',      'Driver pay',                        true,  5),
  ('customs_airport', 'Customs and airport',               false, 6),
  ('rent_salaries',   'Rent and salaries',                 false, 7),
  ('other',           'Other',                             false, 8);

create trigger expense_categories_no_change before update or delete on expense_categories
  for each row execute function gs_forbid_change();

update accounts set name = 'Fuel, dollars' where code = 'expense_fuel_car_usd';
update accounts set name = 'Fuel, dinars' where code = 'expense_fuel_car_iqd';
insert into accounts (code, kind, currency, name) values
  ('expense_car_parts_usd', 'expense', 'USD', 'Car parts and repairs, dollars'),
  ('expense_car_parts_iqd', 'expense', 'IQD', 'Car parts and repairs, dinars'),
  ('expense_workers_usd',   'expense', 'USD', 'Workers and loading, dollars'),
  ('expense_workers_iqd',   'expense', 'IQD', 'Workers and loading, dinars'),
  ('expense_transport_usd', 'expense', 'USD', 'Transport between cities, dollars'),
  ('expense_transport_iqd', 'expense', 'IQD', 'Transport between cities, dinars');

-- ---------------------------------------------------------------------------
-- The driver's account
-- ---------------------------------------------------------------------------

alter table accounts add column driver_id uuid references drivers (id);
alter table accounts drop constraint accounts_system_has_code;
alter table accounts
  add constraint accounts_system_has_code check ((kind in ('customer', 'driver_cash', 'driver_float')) = (code is null)),
  add constraint accounts_driver_float_has_driver check ((kind = 'driver_float') = (driver_id is not null));
create unique index accounts_one_float_per_driver on accounts (driver_id, currency) where kind = 'driver_float';

create function gs_driver_float_account(p_driver_id uuid, p_currency currency) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  select id into v_id from accounts where kind = 'driver_float' and driver_id = p_driver_id and currency = p_currency;
  if v_id is null then
    if not exists (select 1 from drivers where id = p_driver_id) then
      raise exception 'driver_not_found: %', p_driver_id using errcode = 'P0001';
    end if;
    insert into accounts (kind, currency, driver_id, name)
    select 'driver_float', p_currency, d.id, d.name || ', ' || case p_currency when 'USD' then 'dollars' else 'dinars' end
    from drivers d where d.id = p_driver_id
    on conflict (driver_id, currency) where kind = 'driver_float' do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from accounts where kind = 'driver_float' and driver_id = p_driver_id and currency = p_currency;
    end if;
  end if;
  return v_id;
end $$;

insert into entry_shapes (entry_kind, account_kind, direction) values
  ('driver_advance',   'vault',        -1),
  ('driver_advance',   'driver_float',  1),
  ('driver_expense',   'driver_float', -1),
  ('driver_expense',   'expense',       1),
  ('driver_return',    'driver_float', -1),
  ('driver_return',    'vault',         1),
  ('driver_collected', 'driver_float', -1);   -- change given back at the door

-- What a driver's money and an expense were for, next to the entry.
create table expense_details (
  entry_id  uuid primary key references journal_entries (id),
  category  text references expense_categories (code),   -- set for an expense
  driver_id uuid references drivers (id),                -- whose account, or who the receipt is from
  round_id  uuid references rounds (id),
  city      text,
  constraint expense_details_city check (city is null or length(btrim(city)) between 1 and 80)
);

create index expense_details_driver on expense_details (driver_id) where driver_id is not null;
create index expense_details_round on expense_details (round_id) where round_id is not null;

create trigger expense_details_no_change before update or delete on expense_details
  for each row execute function gs_forbid_change();
create trigger expense_details_ceo before insert on expense_details
  for each row execute function gs_ceo_writes();

-- One function for each way the driver's money moves. p_key posts once.
--   advance  the office gives him money from the vault
--   expense  a receipt: what kind, and optionally the city and the round
--   return   he gives back what he did not spend
create function gs_driver_money(
  p_key        text,
  p_what       text,
  p_driver_id  uuid,
  p_currency   currency,
  p_amount     bigint,
  p_user       uuid,
  p_at         timestamptz,
  p_category   text default null,
  p_round_id   uuid default null,
  p_city       text default null,
  p_note       text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_float   uuid;
  v_other   uuid;
  v_kind    entry_kind;
  v_entry   uuid;
  v_driver  drivers%rowtype;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount_invalid: the amount must be more than zero' using errcode = 'P0001';
  end if;
  select * into v_driver from drivers where id = p_driver_id;
  if not found then
    raise exception 'driver_not_found: %', p_driver_id using errcode = 'P0001';
  end if;
  if p_round_id is not null and not exists (select 1 from rounds where id = p_round_id) then
    raise exception 'round_not_found: %', p_round_id using errcode = 'P0001';
  end if;
  v_float := gs_driver_float_account(p_driver_id, p_currency);

  case p_what
    when 'advance' then
      if not v_driver.active then
        raise exception 'driver_inactive: % is switched off' , v_driver.name using errcode = 'P0001';
      end if;
      v_kind := 'driver_advance';
      v_other := gs_account('vault_' || lower(p_currency::text));
    when 'return' then
      v_kind := 'driver_return';
      v_other := gs_account('vault_' || lower(p_currency::text));
    when 'expense' then
      if p_category is null or not exists (select 1 from expense_categories where code = p_category) then
        raise exception 'category_invalid: say what kind of expense it was' using errcode = 'P0001';
      end if;
      v_kind := 'driver_expense';
      v_other := gs_account('expense_' || p_category || '_' || lower(p_currency::text));
    else
      raise exception 'driver_money_invalid: % is not advance, expense or return', p_what using errcode = 'P0001';
  end case;

  select id into v_entry from journal_entries where idempotency_key = p_key;
  if v_entry is not null then
    return v_entry;   -- the same request again
  end if;

  v_entry := gs_post_entry(
    v_kind, p_at, p_user, p_key,
    jsonb_build_array(
      jsonb_build_object('account_id', v_float, 'currency', p_currency,
                         'amount', case when p_what = 'advance' then p_amount else -p_amount end),
      jsonb_build_object('account_id', v_other, 'currency', p_currency,
                         'amount', case when p_what = 'advance' then -p_amount else p_amount end)),
    p_note);
  insert into expense_details (entry_id, category, driver_id, round_id, city)
  values (v_entry, case when p_what = 'expense' then p_category end, p_driver_id, p_round_id, nullif(btrim(p_city), ''));
  return v_entry;
end $$;

-- An expense paid from the vault can say which city and round it was for.
create function gs_note_expense(p_entry_id uuid, p_round_id uuid, p_city text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_category text;
begin
  if not exists (select 1 from journal_entries e where e.id = p_entry_id and e.created_at = now() and e.kind = 'cash_out') then
    raise exception 'entry_closed: an expense says what it was for only while it is being posted' using errcode = 'P0001';
  end if;
  select substring(a.code from '^expense_(.*)_(usd|iqd)$') into v_category
  from journal_lines l join accounts a on a.id = l.account_id and a.kind = 'expense'
  where l.entry_id = p_entry_id;
  insert into expense_details (entry_id, category, round_id, city)
  values (p_entry_id, v_category, p_round_id, nullif(btrim(p_city), ''));
end $$;

-- ---------------------------------------------------------------------------
-- Change at the door
-- ---------------------------------------------------------------------------

-- A dollar payment with change carries the day's rate too: the change was
-- counted at it.
alter table round_results drop constraint round_results_rate_with_dinars;
alter table round_results add column change_iqd bigint,
  add constraint round_results_change check (
    change_iqd is null or (change_iqd > 0 and received_currency = 'USD' and method = 'driver_cash')),
  add constraint round_results_rate_with_dinars check (
    coalesce(received_currency = 'IQD' or change_iqd is not null, false) = (iqd_per_100_usd is not null));
alter table round_result_parts drop constraint round_result_parts_rate_with_dinars;
alter table round_result_parts add column change_iqd bigint,
  add constraint round_result_parts_change check (
    change_iqd is null or (change_iqd > 0 and received_currency = 'USD' and method = 'driver_cash')),
  add constraint round_result_parts_rate_with_dinars check (
    (received_currency = 'IQD' or change_iqd is not null) = (iqd_per_100_usd is not null));

-- What a payment in dollars with dinars given back is worth on the customer's
-- account: the dollars less the dinars at the day's rate, or what is owed
-- when that comes to it give or take half the rounding step. The goods first,
-- then everything he owes; when both, the nearer one.
create function gs_change_credit(p_usd_cents bigint, p_change_iqd bigint, p_iqd_per_100_usd integer,
                                 p_owed_first bigint, p_owed_all bigint) returns bigint
language sql stable as $$
  with x as (
    select p_usd_cents - gs_iqd_to_usd_cents(p_change_iqd, p_iqd_per_100_usd) as exact,
           (select dinar_rounding_iqd from settings) as step
  ), y as (
    select exact,
           coalesce(p_owed_first > 0 and 2 * gs_usd_cents_to_iqd(abs(exact - p_owed_first), p_iqd_per_100_usd) <= step, false) as first_ok,
           coalesce(p_owed_all > 0 and 2 * gs_usd_cents_to_iqd(abs(exact - p_owed_all), p_iqd_per_100_usd) <= step, false) as all_ok
    from x
  )
  select case
           when first_ok and all_ok then
             case when abs(exact - p_owed_first) < abs(exact - p_owed_all) then p_owed_first else p_owed_all end
           when first_ok then p_owed_first
           when all_ok then p_owed_all
           else exact
         end
  from y;
$$;

-- The ledger's own check, as before, and the change rules.
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
  v_change     boolean := false;
  v_floats     integer;
begin
  select count(*) into v_lines from journal_lines where entry_id = new.id;
  if v_lines < 2 then
    raise exception 'entry_incomplete: entry % has % line(s); an entry needs at least two', new.id, v_lines
      using errcode = 'P0001';
  end if;

  -- Change at the door: a driver who took dollars and gave dinars back took
  -- the dinars from his own account (the money the office gave him for the
  -- road). Once, in dinars, against dollars he took, from the round's driver.
  select count(*) into v_floats
  from journal_lines l join accounts a on a.id = l.account_id
  where l.entry_id = new.id and a.kind = 'driver_float';
  if v_floats > 0 and new.reverses_id is null then
    if new.kind = 'driver_collected' then
      v_change := true;
      if v_floats > 1 or exists (
           select 1 from journal_lines l join accounts a on a.id = l.account_id
           where l.entry_id = new.id and a.kind = 'driver_float' and (l.currency <> 'IQD' or l.amount >= 0)) then
        raise exception 'change_invalid: change is given back in dinars, once' using errcode = 'P0001';
      end if;
      if not exists (
           select 1 from journal_lines l
           join accounts a on a.id = l.account_id and a.kind = 'driver_cash'
           join rounds r on r.id = a.round_id
           join journal_lines fl on fl.entry_id = l.entry_id
           join accounts f on f.id = fl.account_id and f.kind = 'driver_float' and f.driver_id = r.driver_id
           where l.entry_id = new.id and l.currency = 'USD' and l.amount > 0) then
        raise exception 'change_invalid: change comes from the round''s own driver, against dollars he took'
          using errcode = 'P0001';
      end if;
    end if;
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
      if v_change then
        -- Dollars in, dinars back as change: the rounding is on the change.
        if 2 * gs_usd_cents_to_iqd(abs(v_rounding), new.iqd_per_100_usd) > (select dinar_rounding_iqd from settings) then
          raise exception 'rounding_too_large: the change is more than half of % IQD away from settling what is owed',
            (select dinar_rounding_iqd from settings) using errcode = 'P0001';
        end if;
      elsif not gs_dinars_settle(abs(v_clear_iqd), new.iqd_per_100_usd, v_credit) then
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

-- Entering a result, as before, and p_change_iqd: the dinars the driver gave
-- back on dollars he took at this stop.
drop function gs_enter_round_result(uuid, uuid, uuid, round_outcome, uuid, timestamptz, bigint, currency, payment_method, text, jsonb);

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
  p_more              jsonb default null,
  p_change_iqd        bigint default null
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
  v_change   bigint;
  v_change_cents bigint;
  v_float    uuid;
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

  -- Change given back: dinars from the driver's own account, on the dollars he took.
  if p_change_iqd is not null then
    if p_change_iqd <= 0 then
      raise exception 'change_invalid: the change is a whole number of dinars, more than zero' using errcode = 'P0001';
    end if;
    if not exists (select 1 from jsonb_array_elements(v_parts) as t (value)
                   where t.value ->> 'currency' = 'USD' and t.value ->> 'method' = 'driver_cash') then
      raise exception 'change_invalid: change is given back in dinars, on dollars the driver took' using errcode = 'P0001';
    end if;
    if v_round.driver_id is null then
      raise exception 'change_invalid: change comes from the driver''s own account, and this round has no driver'
        using errcode = 'P0001';
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

    v_change := case when v_currency = 'USD' and v_method = 'driver_cash' then p_change_iqd end;
    if v_currency = 'USD' and v_change is not null then
      -- He paid in dollars and the driver gave dinars back from his own account.
      v_rate := gs_day_rate(p_happened_at);
      v_change_cents := gs_iqd_to_usd_cents(v_change, v_rate);
      if v_change_cents >= v_amount then
        raise exception 'change_invalid: % IQD of change is worth as much as the % he paid', v_change, gs_money_text(v_amount, 'USD'::currency)
          using errcode = 'P0001';
      end if;
      select remaining_usd_cents into v_remaining from consignment_money where consignment_id = p_consignment_id;
      select balance_usd_cents into v_balance from customer_balances where customer_id = v_customer;
      v_cents := gs_change_credit(v_amount, v_change, v_rate, v_remaining, v_balance);
      v_float := gs_driver_float_account(v_round.driver_id, 'IQD');
      v_entry := gs_post_entry(
        v_kind, p_happened_at, p_user, 'round_result:' || p_id::text || case when v_no = 1 then '' else ':' || v_no end,
        jsonb_build_array(
          jsonb_build_object('account_id', v_into, 'currency', 'USD', 'amount', v_amount),
          jsonb_build_object('account_id', v_float, 'currency', 'IQD', 'amount', -v_change),
          jsonb_build_object('account_id', gs_account('exchange_clearing_iqd'), 'currency', 'IQD', 'amount', v_change),
          jsonb_build_object('account_id', gs_account('exchange_clearing_usd'), 'currency', 'USD', 'amount', -v_change_cents),
          jsonb_build_object('account_id', v_cust_acc, 'currency', 'USD', 'amount', -v_cents))
        || case when v_amount - v_change_cents = v_cents then '[]'::jsonb
                else jsonb_build_array(jsonb_build_object('account_id', gs_account('dinar_rounding_usd'), 'currency', 'USD',
                                                          'amount', v_cents - (v_amount - v_change_cents))) end,
        null, v_rate, null, p_consignment_id);
    elsif v_currency = 'USD' then
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
      'rate', v_rate, 'cents', v_cents, 'entry', v_entry, 'change', v_change));
  end loop;

  v_first := v_posted -> 0;
  insert into round_results
    (id, round_id, consignment_id, outcome, trust_at_time, received_amount, received_currency, method,
     iqd_per_100_usd, credited_usd_cents, happened_at, payment_entry_id, note, entered_by, change_iqd)
  values
    (p_id, p_round_id, p_consignment_id, p_outcome, v_trust,
     (v_first ->> 'amount')::bigint, (v_first ->> 'currency')::currency, (v_first ->> 'method')::payment_method,
     (v_first ->> 'rate')::integer, (v_first ->> 'cents')::bigint, p_happened_at, (v_first ->> 'entry')::uuid,
     nullif(btrim(p_note), ''), p_user, (v_first ->> 'change')::bigint);

  insert into round_result_parts
    (result_id, part_no, received_amount, received_currency, method, iqd_per_100_usd, credited_usd_cents, payment_entry_id, change_iqd)
  select p_id, (x ->> 'no')::smallint, (x ->> 'amount')::bigint, (x ->> 'currency')::currency, (x ->> 'method')::payment_method,
         (x ->> 'rate')::integer, (x ->> 'cents')::bigint, (x ->> 'entry')::uuid, (x ->> 'change')::bigint
  from jsonb_array_elements(v_posted) as x
  where (x ->> 'no')::integer > 1;

  if v_round.status = 'out' then
    update rounds set status = 'returned', returned_at = now() where id = p_round_id;
  end if;

  perform gs_refresh_customer(v_customer);
  return p_id;
end $$;

create or replace view round_payment_entries as
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
       r.voided_at is not null as voided,
       r.change_iqd
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
       r.voided_at is not null,
       p.change_iqd
from round_result_parts p
join round_results r on r.id = p.result_id;

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
                  'credited_usd_cents', rp.credited_usd_cents,
                  'change_iqd', rp.change_iqd) order by rp.part_no)
         from round_payment_entries rp where rp.result_id = r.id), '[]'::jsonb) as payments
from round_stops s
join consignments c on c.id = s.consignment_id
join customers cu on cu.id = c.customer_id
join shipments sh on sh.id = c.shipment_id
join consignment_money cm on cm.consignment_id = c.id
left join round_results r
  on r.round_id = s.round_id and r.consignment_id = s.consignment_id and r.voided_at is null;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

-- Every move on a driver's own account, newest last, with the balance after
-- each, per currency. amount is positive when he holds more of the office's money.
create view driver_account_lines as
select a.driver_id,
       a.currency,
       l.id as line_id,
       e.id as entry_id,
       coalesce(o.kind, e.kind) as kind,
       e.reverses_id is not null as is_reversal,
       exists (select 1 from journal_entries r where r.reverses_id = e.id) as reversed,
       e.happened_at,
       e.created_at,
       l.amount,
       sum(l.amount) over (partition by a.id order by e.happened_at, e.created_at, l.id) as balance_after,
       coalesce(d.category, od.category) as category,
       coalesce(d.round_id, od.round_id, rp.round_id) as round_id,
       coalesce(d.city, od.city) as city,
       e.reason as note,
       rp.consignment_id,
       cu.display_name as customer_name
from journal_lines l
join accounts a on a.id = l.account_id and a.kind = 'driver_float'
join journal_entries e on e.id = l.entry_id
left join journal_entries o on o.id = e.reverses_id
left join expense_details d on d.entry_id = e.id
left join expense_details od on od.entry_id = e.reverses_id
left join round_payment_entries rp on rp.entry_id = coalesce(e.reverses_id, e.id)
left join consignments c on c.id = rp.consignment_id
left join customers cu on cu.id = c.customer_id;

-- Each driver with what he holds of the office's money, per currency.
create view driver_accounts as
select d.id as driver_id,
       d.name,
       d.phone,
       d.active,
       coalesce((select b.balance from accounts a join account_balances b on b.account_id = a.id
                 where a.kind = 'driver_float' and a.driver_id = d.id and a.currency = 'USD'), 0) as holds_usd_cents,
       coalesce((select b.balance from accounts a join account_balances b on b.account_id = a.id
                 where a.kind = 'driver_float' and a.driver_id = d.id and a.currency = 'IQD'), 0) as holds_iqd,
       (select max(x.happened_at) from driver_account_lines x where x.driver_id = d.id) as last_moved_at
from drivers d;

-- Change given at doors, for the round screen and the driver's account.
create view change_given as
select rp.entry_id, rp.result_id, rp.round_id, rp.consignment_id, rp.change_iqd, rp.voided
from round_payment_entries rp
where rp.change_iqd is not null;

grant select on expense_categories, expense_details, driver_account_lines, driver_accounts, change_given to green_star_app;
