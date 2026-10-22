-- Starting balances. Tala, 22 October: "Starting balances: San wants to add
-- them manually. We want to track it from now."
--
-- San types in what stands on the day he starts:
--   - what each customer owes, or the credit he has;
--   - the cash in the vault, in dollars and in dinars;
--   - what Green Star owes the China office.
-- Each is one entry of its own kind against the "Starting balances" account,
-- so the books start from the real numbers and nothing before is made up.
-- Typing one again replaces it: the old one is taken back and the new one
-- posted, so the history shows both. Nobody can post or take back one by
-- hand; gs_set_starting_balance is the only way.
--
-- What a customer owed before is a consignment of its own, on a file called
-- "Starting balances" that counts as older than every file from China, so
-- his payments pay it first, the oldest first as always. That file is never
-- listed with the files from China and never goes on a round. A credit he
-- had is like a payment not used yet: it pays his next file.

alter table shipments add column opening boolean not null default false;
create unique index shipments_one_opening on shipments (opening) where opening;

insert into accounts (code, kind, currency, name) values
  ('opening_balances_usd', 'adjustment', 'USD', 'Starting balances, dollars'),
  ('opening_balances_iqd', 'adjustment', 'IQD', 'Starting balances, dinars');

insert into entry_shapes (entry_kind, account_kind, direction) values
  ('opening_balance', 'customer',       0),
  ('opening_balance', 'vault',          1),
  ('opening_balance', 'china_payable', -1),
  ('opening_balance', 'adjustment',     0);

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
     and not (case v_kind
                when 'error_correction' then v_code = 'errors_usd'
                when 'opening_balance' then v_code in ('opening_balances_usd', 'opening_balances_iqd')
                else v_code = 'dinar_rounding_usd'
              end) then
    raise exception 'entry_shape: a % entry cannot move the % account', v_kind, v_code using errcode = 'P0001';
  end if;

  -- A starting balance is one amount on one account, against the starting balances.
  if v_kind = 'opening_balance' and v_account <> 'adjustment' and exists (
       select 1 from journal_lines l join accounts a on a.id = l.account_id
       where l.entry_id = new.entry_id and a.kind <> 'adjustment') then
    raise exception 'entry_shape: a starting balance is one amount on one account' using errcode = 'P0001';
  end if;

  -- One payment, one charge, one Error entry and one starting balance is one customer and one amount in one currency.
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
  if new.kind = 'opening_balance' then
    raise exception 'starting_balance_by_function: a starting balance is set with gs_set_starting_balance' using errcode = 'P0001';
  end if;
  if new.reverses_id is not null then
    select kind into v_kind from journal_entries where id = new.reverses_id;
    if v_kind = 'opening_balance' then
      raise exception 'starting_balance_by_function: a starting balance is changed by setting it again' using errcode = 'P0001';
    end if;
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

-- A credit from before pays his next file, like a payment not used yet.
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
where e.kind in ('driver_collected', 'office_payment', 'wallet_payment', 'error_correction', 'opening_balance')
  and not exists (select 1 from journal_entries r where r.reverses_id = e.id)
group by e.id, a.customer_id, e.kind, e.happened_at, e.created_at
having e.kind not in ('error_correction', 'opening_balance') or -sum(l.amount) > 0;

-- The starting balance standing on each account now: one row per account.
-- amount is as the account sees it: a customer's debt is positive and his
-- credit negative, the vault's cash is positive, what is owed to China is
-- negative.
create view starting_balances as
select e.id as entry_id,
       e.happened_at,
       e.created_at,
       e.created_by,
       a.id as account_id,
       a.code as account_code,
       a.kind as account_kind,
       a.customer_id,
       l.currency,
       l.amount
from journal_entries e
join journal_lines l on l.entry_id = e.id
join accounts a on a.id = l.account_id and a.kind <> 'adjustment'
where e.kind = 'opening_balance'
  and e.reverses_id is null
  and not exists (select 1 from journal_entries r where r.reverses_id = e.id);

grant select on starting_balances to green_star_app;

-- Sets one starting balance, or clears it with 0.
--   p_what   'customer' (p_customer_id says who; p_amount above 0 is what he
--            owes, below 0 the credit he has), 'vault_usd', 'vault_iqd' (the
--            cash, 0 or more) or 'china' (what is owed to China, 0 or more).
--   p_id     this request: sent again, it changes nothing.
-- Returns the new entry, or null when the balance is now nothing.
create function gs_set_starting_balance(
  p_id          uuid,
  p_user        uuid,
  p_what        text,
  p_amount      bigint,
  p_customer_id uuid default null,
  p_at          timestamptz default now()
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key      text := 'start:' || p_id::text;
  v_entry    uuid;
  v_account  uuid;
  v_currency currency;
  v_line     bigint;
  v_old      record;
  v_con      uuid;
  v_file     uuid;
begin
  select id into v_entry from journal_entries where idempotency_key = v_key;
  if found then
    return v_entry;
  end if;
  if p_amount is null then
    raise exception 'amount_invalid: say the amount, or 0 for nothing' using errcode = 'P0001';
  end if;

  if p_what = 'customer' then
    if p_customer_id is null or not exists (select 1 from customers where id = p_customer_id) then
      raise exception 'customer_not_found: %', p_customer_id using errcode = 'P0001';
    end if;
    perform gs_lock_customer(p_customer_id);
    v_account := gs_customer_account(p_customer_id);
    v_currency := 'USD';
  elsif p_what in ('vault_usd', 'vault_iqd', 'china') then
    if p_customer_id is not null then
      raise exception 'starting_balance_invalid: % is not a customer''s', p_what using errcode = 'P0001';
    end if;
    if p_amount < 0 then
      raise exception 'amount_invalid: % cannot start below nothing', p_what using errcode = 'P0001';
    end if;
    v_account := gs_account(case p_what when 'china' then 'china_payable' else p_what end);
    v_currency := case p_what when 'vault_iqd' then 'IQD' else 'USD' end;
  else
    raise exception 'starting_balance_invalid: % has no starting balance', p_what using errcode = 'P0001';
  end if;

  -- One change to an account's starting balance at a time.
  perform pg_advisory_xact_lock(hashtextextended('gs_start:' || v_account::text, 0));
  v_line := case when p_what = 'china' then -p_amount else p_amount end;

  select sb.entry_id, sb.amount into v_old from starting_balances sb where sb.account_id = v_account;
  if found then
    if v_old.amount = v_line then
      return v_old.entry_id;   -- already so
    end if;
    select id into v_con from consignments where charge_entry_id = v_old.entry_id;
    if v_con is not null then
      perform gs_cancel_consignment(v_con, p_user, 'Starting balance typed again');
    else
      perform gs_reverse_entry(v_old.entry_id, p_user, 'Starting balance typed again', v_key || ':undo', p_at);
    end if;
  end if;
  if v_line = 0 then
    return null;
  end if;

  v_entry := gs_post_entry(
    'opening_balance', p_at, p_user, v_key,
    jsonb_build_array(
      jsonb_build_object('account_id', v_account, 'currency', v_currency, 'amount', v_line),
      jsonb_build_object('account_id', gs_account(case v_currency when 'USD' then 'opening_balances_usd' else 'opening_balances_iqd' end),
                         'currency', v_currency, 'amount', -v_line)),
    'Starting balance');

  if p_what = 'customer' and v_line > 0 then
    select id into v_file from shipments where opening;
    if not found then
      insert into shipments (code, status, confirmed_at, confirmed_by, opening)
      values ('Starting balances', 'confirmed', '2000-01-01T00:00:00Z', p_user, true)
      returning id into v_file;
    end if;
    insert into consignments (shipment_id, customer_id, amount_due_usd_cents, charge_entry_id)
    values (v_file, p_customer_id, v_line, v_entry);
    perform gs_allocate_customer(p_customer_id);
  end if;
  return v_entry;
end $$;

revoke execute on function gs_set_starting_balance(uuid, uuid, text, bigint, uuid, timestamptz) from public;
grant execute on function gs_set_starting_balance(uuid, uuid, text, bigint, uuid, timestamptz) to green_star_app;

-- What he owed before is money, not goods: it never goes on a round.
create function gs_no_starting_goods() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (select 1 from consignments c join shipments s on s.id = c.shipment_id
             where c.id = new.consignment_id and s.opening) then
    raise exception 'starting_balance_not_goods: what he owed before is not goods to deliver' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger round_stops_not_starting before insert on round_stops
  for each row execute function gs_no_starting_goods();
