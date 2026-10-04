-- Dinar rounding and the "Error" entry: the CEO's rules for the small
-- differences that come with taking money in two currencies.
--
-- His words. "Sometimes a customer owes $533. $400 he pays with dollars, $133
-- with dinars: 133 x 1,570 = 208,810. What I do is $400 + 209,000 IQD = $533."
-- "You can just do a normal rounding." "If there becomes a $5 error or
-- something, I will just do a data entry and call it Error."
--
-- What the database guarantees here:
--   1. Dinars handed over are still converted at the day's rate, to the cent.
--      Nothing about that changes.
--   2. A dinar payment that comes to what is owed, give or take half the
--      rounding step (1,000 dinars, so 500 either way), settles it exactly.
--      "What is owed" is the consignment the payment is for, or everything
--      the customer owes. Nothing else is ever rounded: not a dollar payment,
--      not a part payment, not an overpayment.
--   3. The difference is not lost. It is a line on the "Dinar rounding"
--      account in the same entry, so the books say what rounding gave and took.
--   4. An Error entry takes a small amount off what one customer owes, and
--      puts it on the "Errors" account. It is never more than the limit in
--      Settings ($5), never more than he owes, and it is reversed like any
--      other entry.
--   5. Both limits are in the one settings row, changed only by the CEO.

-- ---------------------------------------------------------------------------
-- The two settings
-- ---------------------------------------------------------------------------

alter table settings
  add column dinar_rounding_iqd  integer not null default 1000,
  add column error_max_usd_cents integer not null default 500,
  add constraint settings_dinar_rounding check (dinar_rounding_iqd between 0 and 10000),
  add constraint settings_error_max check (error_max_usd_cents between 0 and 10000);

grant update (dinar_rounding_iqd, error_max_usd_cents) on settings to green_star_app;

-- ---------------------------------------------------------------------------
-- The two accounts, and what may move them
-- ---------------------------------------------------------------------------

insert into accounts (code, kind, currency, name) values
  ('dinar_rounding_usd', 'adjustment', 'USD', 'Dinar rounding'),
  ('errors_usd',         'adjustment', 'USD', 'Errors');

insert into entry_shapes (entry_kind, account_kind, direction) values
  ('driver_collected', 'adjustment',  0),   -- rounding goes either way
  ('office_payment',   'adjustment',  0),
  ('wallet_payment',   'adjustment',  0),
  ('error_correction', 'customer',   -1),   -- he owes less
  ('error_correction', 'adjustment',  1);

-- As before, and: a payment touches only the rounding account, an Error entry
-- only the errors account, and an Error entry is for one customer.
create or replace function gs_line_shape() returns trigger
language plpgsql as $$
declare
  v_kind     entry_kind;
  v_reverses uuid;
  v_account  account_kind;
  v_code     text;
begin
  select kind, reverses_id into v_kind, v_reverses from journal_entries where id = new.entry_id;
  if v_reverses is not null then
    return new;   -- a reversal is the mirror of its entry; that is checked on its own
  end if;
  select kind, code into v_account, v_code from accounts where id = new.account_id;
  if v_account is null then
    return new;   -- no such account: the foreign key says so
  end if;

  if not exists (
    select 1 from entry_shapes s
    where s.entry_kind = v_kind and s.account_kind = v_account
      and (s.direction = 0 or s.direction = sign(new.amount))
  ) then
    raise exception 'entry_shape: a % entry cannot move a % account %',
      v_kind, v_account, case when new.amount > 0 then 'up' else 'down' end
      using errcode = 'P0001';
  end if;

  if v_account = 'adjustment'
     and v_code is distinct from (case when v_kind = 'error_correction' then 'errors_usd' else 'dinar_rounding_usd' end) then
    raise exception 'entry_shape: a % entry cannot move the % account', v_kind, v_code using errcode = 'P0001';
  end if;

  -- One payment, one charge and one Error entry is one customer and one amount in one currency.
  if v_kind in ('file_confirmed', 'driver_collected', 'office_payment', 'wallet_payment', 'error_correction') then
    if v_account = 'customer' and exists (
         select 1 from journal_lines l join accounts a on a.id = l.account_id
         where l.entry_id = new.entry_id and a.kind = 'customer') then
      raise exception 'entry_shape: a % entry is for one customer', v_kind using errcode = 'P0001';
    end if;
    if v_account in ('vault', 'wallet', 'driver_cash') and exists (
         select 1 from journal_lines l join accounts a on a.id = l.account_id
         where l.entry_id = new.entry_id and a.kind in ('vault', 'wallet', 'driver_cash')) then
      raise exception 'entry_shape: a % entry is one amount in one currency', v_kind using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- The arithmetic, the same as the app's
-- ---------------------------------------------------------------------------

-- $85.00 at 145,000 per $100 is 123,250 IQD. Half a dinar rounds up.
create function gs_usd_cents_to_iqd(p_cents bigint, p_iqd_per_100_usd integer) returns bigint
language sql immutable strict as $$
  select (p_cents * p_iqd_per_100_usd::bigint * 2 + 10000) / 20000;
$$;

-- True when these dinars come to this many cents, give or take half the
-- rounding step. $133.00 at 157,000 is 208,810 IQD: 209,000 settles it, and
-- so does 208,500. 208,000 does not.
create function gs_dinars_settle(p_dinars bigint, p_iqd_per_100_usd integer, p_owed_usd_cents bigint) returns boolean
language sql stable as $$
  select coalesce(
    p_owed_usd_cents > 0
    and 2 * abs(p_dinars - gs_usd_cents_to_iqd(p_owed_usd_cents, p_iqd_per_100_usd))
        <= (select dinar_rounding_iqd from settings),
    false);
$$;

-- What a dinar payment is worth on the customer's account: what is owed, when
-- the dinars settle it, and otherwise exactly what they convert to. The first
-- amount is tried first: the consignment the money is for, then everything
-- he owes.
create function gs_dinar_credit(p_dinars bigint, p_iqd_per_100_usd integer, p_owed_first bigint, p_owed_all bigint) returns bigint
language sql stable as $$
  select case
           when gs_dinars_settle(p_dinars, p_iqd_per_100_usd, p_owed_first) then p_owed_first
           when gs_dinars_settle(p_dinars, p_iqd_per_100_usd, p_owed_all) then p_owed_all
           else gs_iqd_to_usd_cents(p_dinars, p_iqd_per_100_usd)
         end;
$$;

-- The lines of a customer's payment in dinars. The dinars pass through the
-- exchange clearing accounts at exactly what they convert to; when the
-- customer is credited something else, the difference is the rounding line.
create function gs_dinar_payment_lines(
  p_into uuid, p_customer_account uuid, p_dinars bigint, p_iqd_per_100_usd integer, p_credit_usd_cents bigint
) returns jsonb
language sql stable as $$
  select jsonb_build_array(
           jsonb_build_object('account_id', p_into, 'currency', 'IQD', 'amount', p_dinars),
           jsonb_build_object('account_id', gs_account('exchange_clearing_iqd'), 'currency', 'IQD', 'amount', -p_dinars),
           jsonb_build_object('account_id', gs_account('exchange_clearing_usd'), 'currency', 'USD',
                              'amount', gs_iqd_to_usd_cents(p_dinars, p_iqd_per_100_usd)),
           jsonb_build_object('account_id', p_customer_account, 'currency', 'USD', 'amount', -p_credit_usd_cents))
         || case when gs_iqd_to_usd_cents(p_dinars, p_iqd_per_100_usd) = p_credit_usd_cents then '[]'::jsonb
                 else jsonb_build_array(jsonb_build_object(
                        'account_id', gs_account('dinar_rounding_usd'), 'currency', 'USD',
                        'amount', p_credit_usd_cents - gs_iqd_to_usd_cents(p_dinars, p_iqd_per_100_usd)))
            end;
$$;

-- ---------------------------------------------------------------------------
-- The ledger's own check, with the two new rules
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
  v_max        integer;
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

  -- An Error entry: a small amount off what one customer owes.
  if new.kind = 'error_correction' then
    select a.customer_id, -sum(l.amount) into v_customer, v_credit
    from journal_lines l join accounts a on a.id = l.account_id
    where l.entry_id = new.id and a.kind = 'customer'
    group by a.customer_id;
    if v_credit is null or v_credit <= 0 then
      raise exception 'error_invalid: an Error entry takes an amount off what one customer owes' using errcode = 'P0001';
    end if;
    select error_max_usd_cents into v_max from settings;
    if v_credit > v_max then
      raise exception 'error_too_large: an Error entry is at most %. The limit is in Settings.', gs_money_text(v_max, 'USD'::currency)
        using errcode = 'P0001';
    end if;
    select balance_usd_cents into v_balance from customer_balances where customer_id = v_customer;
    if v_balance < 0 then
      raise exception 'error_more_than_owed: he owes %, so an Error entry cannot take off %',
        gs_money_text(v_balance + v_credit, 'USD'::currency), gs_money_text(v_credit, 'USD'::currency)
        using errcode = 'P0001';
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

-- gs_post_entry, unchanged except for the order: the entry says which
-- consignment it is for before the ledger checks it, because the rounding
-- rule needs to know.
create or replace function gs_post_entry(
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

  if p_for_consignment is not null then
    perform gs_set_payment_target(v_id, p_for_consignment);
  end if;

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
-- An Error entry pays what he owes, oldest first, the way a payment does
-- ---------------------------------------------------------------------------

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
group by e.id, a.customer_id, e.kind, e.happened_at, e.created_at;

-- Every Error entry, for the Money screen.
create view error_entries as
select e.id as entry_id,
       a.customer_id,
       cu.display_name as customer_name,
       -l.amount as amount_usd_cents,
       e.happened_at,
       e.created_at,
       e.created_by,
       e.reason as note,
       exists (select 1 from journal_entries r where r.reverses_id = e.id) as reversed
from journal_entries e
join journal_lines l on l.entry_id = e.id
join accounts a on a.id = l.account_id and a.kind = 'customer'
join customers cu on cu.id = a.customer_id
where e.kind = 'error_correction';

-- What rounding gave and took, per payment: positive when the customer's
-- dinars were worth more than he was credited.
create view dinar_rounding as
select e.id as entry_id,
       e.happened_at,
       -l.amount as gained_usd_cents,
       exists (select 1 from journal_entries r where r.reverses_id = e.id) as reversed
from journal_entries e
join journal_lines l on l.entry_id = e.id
join accounts a on a.id = l.account_id and a.code = 'dinar_rounding_usd'
where e.reverses_id is null;

grant select on error_entries, dinar_rounding to green_star_app;
