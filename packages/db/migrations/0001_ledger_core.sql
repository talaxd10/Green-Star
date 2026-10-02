-- Green Star ledger core.
--
-- Double-entry, append-only. Customer accounts are in US dollars; cash is held
-- in dollars and dinars. Amounts are whole numbers in the smallest unit:
-- USD in cents, IQD in whole dinars. Never floating point.
--
-- Sign convention: a positive line is "goes up" for money we hold or are owed
-- (customer accounts, driver cash, vault, wallets, expenses); a negative line
-- is "goes down". Money we owe the China office is a negative balance.
--
-- What the database guarantees, whatever the application does:
--   1. Every entry sums to zero in each currency.
--   2. Entries and lines are never updated or deleted.
--   3. A line's currency matches its account's currency.
--   4. Lines can only be written in the transaction that creates their entry.
--   5. A reversal is the exact mirror of the entry it reverses, once only.
--   6. An idempotency key posts once, however many times it is sent.
--   7. A customer payment in dinars converts at that day's rate, to the cent.

create type currency as enum ('USD', 'IQD');

create type account_kind as enum (
  'customer',          -- what one customer owes, USD
  'driver_cash',       -- cash a driver or carrier holds for one round
  'vault',             -- the office vault, one account per currency
  'wallet',            -- FIB, FastPay, ZainCash
  'china_payable',     -- collected money owed to the China office
  'expense',           -- cash out, by category
  'exchange_clearing'  -- the two legs of every currency conversion
);

create type entry_kind as enum (
  'file_confirmed',
  'driver_collected',
  'round_handed_in',
  'office_payment',
  'wallet_payment',
  'sent_to_china',
  'cash_out',
  'currency_exchange',
  'reversal'
);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create table accounts (
  id          uuid primary key default gen_random_uuid(),
  code        text unique,          -- set for fixed system accounts only
  kind        account_kind not null,
  currency    currency not null,
  customer_id uuid,                 -- FK added when the customers table lands
  round_id    uuid,                 -- FK added when the rounds table lands
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (id, currency),
  constraint accounts_customer_has_customer check ((kind = 'customer') = (customer_id is not null)),
  constraint accounts_driver_cash_has_round check ((kind = 'driver_cash') = (round_id is not null)),
  constraint accounts_customer_in_usd check (kind <> 'customer' or currency = 'USD'),
  constraint accounts_system_has_code check ((kind in ('customer', 'driver_cash')) = (code is null))
);

create unique index accounts_one_per_customer on accounts (customer_id) where kind = 'customer';
create unique index accounts_one_per_round_currency on accounts (round_id, currency) where kind = 'driver_cash';

insert into accounts (code, kind, currency, name) values
  ('vault_usd',               'vault',             'USD', 'Vault, dollars'),
  ('vault_iqd',               'vault',             'IQD', 'Vault, dinars'),
  ('wallet_fib_usd',          'wallet',            'USD', 'FIB, dollars'),
  ('wallet_fib_iqd',          'wallet',            'IQD', 'FIB, dinars'),
  ('wallet_fastpay_usd',      'wallet',            'USD', 'FastPay, dollars'),
  ('wallet_fastpay_iqd',      'wallet',            'IQD', 'FastPay, dinars'),
  ('wallet_zaincash_usd',     'wallet',            'USD', 'ZainCash, dollars'),
  ('wallet_zaincash_iqd',     'wallet',            'IQD', 'ZainCash, dinars'),
  ('china_payable',           'china_payable',     'USD', 'Owed to the China office'),
  ('exchange_clearing_usd',   'exchange_clearing', 'USD', 'Exchange clearing, dollars'),
  ('exchange_clearing_iqd',   'exchange_clearing', 'IQD', 'Exchange clearing, dinars'),
  ('expense_driver_pay_usd',      'expense', 'USD', 'Driver pay, dollars'),
  ('expense_driver_pay_iqd',      'expense', 'IQD', 'Driver pay, dinars'),
  ('expense_fuel_car_usd',        'expense', 'USD', 'Fuel and car, dollars'),
  ('expense_fuel_car_iqd',        'expense', 'IQD', 'Fuel and car, dinars'),
  ('expense_customs_airport_usd', 'expense', 'USD', 'Customs and airport, dollars'),
  ('expense_customs_airport_iqd', 'expense', 'IQD', 'Customs and airport, dinars'),
  ('expense_rent_salaries_usd',   'expense', 'USD', 'Rent and salaries, dollars'),
  ('expense_rent_salaries_iqd',   'expense', 'IQD', 'Rent and salaries, dinars'),
  ('expense_other_usd',           'expense', 'USD', 'Other expenses, dollars'),
  ('expense_other_iqd',           'expense', 'IQD', 'Other expenses, dinars');

-- ---------------------------------------------------------------------------
-- Journal
-- ---------------------------------------------------------------------------

create table journal_entries (
  id              uuid primary key default gen_random_uuid(),
  kind            entry_kind not null,
  happened_at     timestamptz not null,   -- when the money moved
  created_at      timestamptz not null default now(),
  created_by      uuid not null,          -- FK added when the users table lands
  reason          text,
  reverses_id     uuid references journal_entries (id),
  idempotency_key text not null unique,
  iqd_per_100_usd integer,                -- the rate used, when dinars were converted
  constraint journal_entries_rate_positive check (iqd_per_100_usd is null or iqd_per_100_usd > 0),
  constraint journal_entries_reversal_has_target check ((kind = 'reversal') = (reverses_id is not null)),
  constraint journal_entries_reason_required check (
    kind not in ('reversal', 'cash_out') or length(btrim(coalesce(reason, ''))) > 0
  )
);

create unique index journal_entries_reversed_once on journal_entries (reverses_id) where reverses_id is not null;
create index journal_entries_happened_at on journal_entries (happened_at);

create table journal_lines (
  id         bigint generated always as identity primary key,
  entry_id   uuid not null references journal_entries (id),
  account_id uuid not null,
  currency   currency not null,
  amount     bigint not null,
  constraint journal_lines_amount_not_zero check (amount <> 0),
  constraint journal_lines_account_currency foreign key (account_id, currency) references accounts (id, currency)
);

create index journal_lines_entry on journal_lines (entry_id);
create index journal_lines_account on journal_lines (account_id);

-- One dinar rate per Baghdad day, set by the CEO. Whole dinars per 100 US
-- dollars, the way the market quotes it: 145000 is 1,450 per dollar, and
-- 152750 is 1,527.5 per dollar.
create table fx_rates (
  day             date primary key,
  iqd_per_100_usd integer not null check (iqd_per_100_usd > 0),
  set_by          uuid not null,
  set_at          timestamptz not null default now()
);

-- Balances are never typed in. This table is a cache of sum(lines), kept in
-- step by a trigger in the same transaction as the line.
create table account_balances (
  account_id uuid primary key references accounts (id),
  currency   currency not null,
  balance    bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Guard: nothing in the ledger is edited or deleted
-- ---------------------------------------------------------------------------

create function gs_forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception 'ledger_immutable: % on % is not allowed. Post a reversal instead.', tg_op, tg_table_name
    using errcode = 'P0001';
end $$;

create trigger journal_entries_no_change before update or delete on journal_entries
  for each row execute function gs_forbid_change();
create trigger journal_entries_no_truncate before truncate on journal_entries
  for each statement execute function gs_forbid_change();
create trigger journal_lines_no_change before update or delete on journal_lines
  for each row execute function gs_forbid_change();
create trigger journal_lines_no_truncate before truncate on journal_lines
  for each statement execute function gs_forbid_change();

-- An account keeps its identity for life. Only its display name may change.
create function gs_accounts_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'account_immutable: accounts are never deleted' using errcode = 'P0001';
  end if;
  if (new.id, new.code, new.kind, new.currency, new.customer_id, new.round_id)
     is distinct from
     (old.id, old.code, old.kind, old.currency, old.customer_id, old.round_id) then
    raise exception 'account_immutable: only the name of an account can change' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger accounts_guard before update or delete on accounts
  for each row execute function gs_accounts_guard();

-- ---------------------------------------------------------------------------
-- Guard: lines belong to the transaction that created their entry
-- ---------------------------------------------------------------------------

create function gs_entry_stamp() returns trigger
language plpgsql as $$
begin
  new.created_at := now();   -- transaction start time; cannot be supplied
  return new;
end $$;

create trigger journal_entries_stamp before insert on journal_entries
  for each row execute function gs_entry_stamp();

create function gs_line_same_transaction() returns trigger
language plpgsql as $$
declare
  v_created timestamptz;
begin
  select created_at into v_created from journal_entries where id = new.entry_id;
  if v_created is distinct from now() then
    raise exception 'entry_closed: lines can only be added while the entry is being posted'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger journal_lines_same_transaction before insert on journal_lines
  for each row execute function gs_line_same_transaction();

-- ---------------------------------------------------------------------------
-- Balance cache
-- ---------------------------------------------------------------------------

create function gs_apply_line_to_balance() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into account_balances (account_id, currency, balance)
  values (new.account_id, new.currency, new.amount)
  on conflict (account_id) do update
    set balance = account_balances.balance + excluded.balance,
        updated_at = now();
  return null;
end $$;

create trigger journal_lines_balance after insert on journal_lines
  for each row execute function gs_apply_line_to_balance();

-- ---------------------------------------------------------------------------
-- Guard: every entry sums to zero per currency (checked at commit)
-- ---------------------------------------------------------------------------

create function gs_check_lines_balanced() returns trigger
language plpgsql as $$
declare
  v_bad record;
begin
  select l.currency, sum(l.amount) as off into v_bad
  from journal_lines l
  where l.entry_id = new.entry_id
  group by l.currency
  having sum(l.amount) <> 0
  limit 1;
  if found then
    raise exception 'entry_unbalanced: entry % is off by % %', new.entry_id, v_bad.off, v_bad.currency
      using errcode = 'P0001';
  end if;
  return null;
end $$;

create constraint trigger journal_lines_balanced after insert on journal_lines
  deferrable initially deferred
  for each row execute function gs_check_lines_balanced();

-- ---------------------------------------------------------------------------
-- Guard: an entry is complete, converts at its rate, and reverses exactly
-- ---------------------------------------------------------------------------

create function gs_check_entry_complete() returns trigger
language plpgsql as $$
declare
  v_lines      integer;
  v_clear_usd  bigint;
  v_clear_iqd  bigint;
  v_day_rate   integer;
  v_orig       journal_entries%rowtype;
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
    -- and the dollars credited must be what the dinars are worth at that rate.
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

create constraint trigger journal_entries_complete after insert on journal_entries
  deferrable initially deferred
  for each row execute function gs_check_entry_complete();

-- ---------------------------------------------------------------------------
-- Posting. The application calls these; it never inserts lines by hand.
-- ---------------------------------------------------------------------------

-- Posts one entry with its lines. Sending the same idempotency key again
-- returns the first entry's id and writes nothing, so a double click or a
-- retried request never posts twice.
--
-- p_lines: [{"account_id": "<uuid>", "currency": "USD", "amount": 8500}, ...]
create function gs_post_entry(
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

  return v_id;
end $$;

-- Reverses an entry by posting its exact mirror. The only way to fix a mistake.
create function gs_reverse_entry(
  p_entry_id        uuid,
  p_created_by      uuid,
  p_reason          text,
  p_idempotency_key text,
  p_happened_at     timestamptz default now()
) returns uuid
language plpgsql as $$
declare
  v_orig  journal_entries%rowtype;
  v_lines jsonb;
begin
  select * into v_orig from journal_entries where id = p_entry_id;
  if not found then
    raise exception 'entry_not_found: %', p_entry_id using errcode = 'P0001';
  end if;

  select jsonb_agg(jsonb_build_object('account_id', account_id, 'currency', currency, 'amount', -amount) order by id)
    into v_lines
  from journal_lines where entry_id = p_entry_id;

  return gs_post_entry('reversal', p_happened_at, p_created_by, p_idempotency_key, v_lines,
                       p_reason, v_orig.iqd_per_100_usd, p_entry_id);
exception
  when unique_violation then
    raise exception 'already_reversed: entry % has already been reversed', p_entry_id using errcode = 'P0001';
end $$;

-- ---------------------------------------------------------------------------
-- Account lookups
-- ---------------------------------------------------------------------------

create function gs_account(p_code text) returns uuid
language plpgsql stable as $$
declare
  v_id uuid;
begin
  select id into v_id from accounts where code = p_code;
  if v_id is null then
    raise exception 'account_not_found: %', p_code using errcode = 'P0001';
  end if;
  return v_id;
end $$;

create function gs_customer_account(p_customer_id uuid, p_name text default null) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  select id into v_id from accounts where kind = 'customer' and customer_id = p_customer_id;
  if v_id is null then
    insert into accounts (kind, currency, customer_id, name)
    values ('customer', 'USD', p_customer_id, coalesce(p_name, 'Customer ' || p_customer_id))
    on conflict (customer_id) where kind = 'customer' do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from accounts where kind = 'customer' and customer_id = p_customer_id;
    end if;
  end if;
  return v_id;
end $$;

create function gs_driver_cash_account(p_round_id uuid, p_currency currency, p_name text default null) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  select id into v_id from accounts
  where kind = 'driver_cash' and round_id = p_round_id and currency = p_currency;
  if v_id is null then
    insert into accounts (kind, currency, round_id, name)
    values ('driver_cash', p_currency, p_round_id, coalesce(p_name, 'Round ' || p_round_id || ' cash, ' || p_currency))
    on conflict (round_id, currency) where kind = 'driver_cash' do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from accounts
      where kind = 'driver_cash' and round_id = p_round_id and currency = p_currency;
    end if;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

create view customer_balances as
select a.customer_id,
       a.id as account_id,
       coalesce(b.balance, 0) as balance_usd_cents
from accounts a
left join account_balances b on b.account_id = a.id
where a.kind = 'customer';

-- Health check: every row returned is a problem. Empty means the books are sound.
create function gs_ledger_health() returns table (problem text, detail text)
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
  where (select count(*) from journal_lines l where l.entry_id = e.id) < 2;
$$;

-- ---------------------------------------------------------------------------
-- The application's role: it can add to the ledger and never change it
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'green_star_app') then
    create role green_star_app nologin;
  end if;
end $$;

grant usage on schema public to green_star_app;
grant select, insert on accounts, journal_entries, journal_lines to green_star_app;
grant select on account_balances, customer_balances to green_star_app;
grant select, insert, update on fx_rates to green_star_app;
grant usage on sequence journal_lines_id_seq to green_star_app;
