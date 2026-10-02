-- Money at the office: what each kind of entry may move, today's rate, the
-- daily vault close, and the China account.
--
-- What the database guarantees here:
--   1. Each kind of entry moves only the accounts it is meant to, in the
--      direction it is meant to. A customer's account goes down only against
--      money that really arrived: cash, a wallet, or a driver's round. That is
--      what "no discounts or write-offs" means in the ledger.
--   2. One payment is one customer and one amount in one currency.
--   3. The day's rate is set through one function that logs every change, and
--      a rate far from the last one has to be confirmed.
--   4. The vault is closed by counting it note by note. A gap needs a note.
--      Expected cash is the last count plus everything entered since.
--   5. A count is never edited. A wrong one is taken back and counted again.

-- ---------------------------------------------------------------------------
-- What each kind of entry may move
-- ---------------------------------------------------------------------------

-- The ledger table from the board, as data. direction: 1 goes up, -1 goes down,
-- 0 either way.
create table entry_shapes (
  entry_kind   entry_kind not null,
  account_kind account_kind not null,
  direction    smallint not null check (direction in (-1, 0, 1)),
  primary key (entry_kind, account_kind)
);

insert into entry_shapes (entry_kind, account_kind, direction) values
  ('file_confirmed',    'customer',           1),   -- the customer owes the amount to collect
  ('file_confirmed',    'china_payable',     -1),   -- and we owe it to the China office
  ('driver_collected',  'driver_cash',        1),
  ('driver_collected',  'customer',          -1),
  ('driver_collected',  'exchange_clearing',  0),
  ('office_payment',    'vault',              1),
  ('office_payment',    'customer',          -1),
  ('office_payment',    'exchange_clearing',  0),
  ('wallet_payment',    'wallet',             1),
  ('wallet_payment',    'customer',          -1),
  ('wallet_payment',    'exchange_clearing',  0),
  ('round_handed_in',   'vault',              1),
  ('round_handed_in',   'driver_cash',       -1),
  ('sent_to_china',     'china_payable',      1),   -- paid down
  ('sent_to_china',     'vault',             -1),
  ('cash_out',          'expense',            1),
  ('cash_out',          'vault',             -1),
  ('currency_exchange', 'vault',              0),
  ('currency_exchange', 'exchange_clearing',  0);

create function gs_line_shape() returns trigger
language plpgsql as $$
declare
  v_kind     entry_kind;
  v_reverses uuid;
  v_account  account_kind;
begin
  select kind, reverses_id into v_kind, v_reverses from journal_entries where id = new.entry_id;
  if v_reverses is not null then
    return new;   -- a reversal is the mirror of its entry; that is checked on its own
  end if;
  select kind into v_account from accounts where id = new.account_id;
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

  -- One payment, and one charge, is one customer and one amount in one currency.
  if v_kind in ('file_confirmed', 'driver_collected', 'office_payment', 'wallet_payment') then
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

create trigger journal_lines_shape before insert on journal_lines
  for each row execute function gs_line_shape();

create trigger entry_shapes_no_change before update or delete on entry_shapes
  for each row execute function gs_forbid_change();

-- ---------------------------------------------------------------------------
-- Today's rate
-- ---------------------------------------------------------------------------

create table fx_rate_changes (
  id          bigint generated always as identity primary key,
  day         date not null,
  rate_before integer,
  rate_after  integer not null,
  set_by      uuid not null,
  set_at      timestamptz not null default now()
);

create trigger fx_rate_changes_no_change before update or delete on fx_rate_changes
  for each row execute function gs_forbid_change();

-- Sets the dinar rate of a Baghdad day, in whole dinars per 100 dollars.
-- A rate more than 20% away from the last one set is almost always a typing
-- mistake (1,450 instead of 145,000), so it has to be sent again with
-- p_confirm_jump. Every change is logged.
create function gs_set_rate(
  p_day             date,
  p_iqd_per_100_usd integer,
  p_user            uuid,
  p_confirm_jump    boolean default false
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old  integer;
  v_last integer;
begin
  if p_day is null or p_iqd_per_100_usd is null or p_iqd_per_100_usd <= 0 then
    raise exception 'rate_invalid: a rate is a positive whole number of dinars per 100 dollars' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gs_rate:' || p_day::text, 0));
  select iqd_per_100_usd into v_old from fx_rates where day = p_day;
  if v_old = p_iqd_per_100_usd then
    return;
  end if;

  select iqd_per_100_usd into v_last from fx_rates where day <> p_day order by abs(day - p_day), day desc limit 1;
  v_last := coalesce(v_old, v_last);
  if v_last is not null and not p_confirm_jump
     and abs(p_iqd_per_100_usd - v_last)::bigint * 5 > v_last then
    raise exception 'rate_jump: % is far from the last rate, %. Send it again to confirm.', p_iqd_per_100_usd, v_last
      using errcode = 'P0001';
  end if;

  insert into fx_rates (day, iqd_per_100_usd, set_by) values (p_day, p_iqd_per_100_usd, p_user)
  on conflict (day) do update set iqd_per_100_usd = excluded.iqd_per_100_usd, set_by = excluded.set_by, set_at = now();
  insert into fx_rate_changes (day, rate_before, rate_after, set_by) values (p_day, v_old, p_iqd_per_100_usd, p_user);
end $$;

revoke insert, update on fx_rates from green_star_app;

-- Dinar payments that were posted before the day's rate was changed. They
-- stand at the rate they were entered with; each one is reversed and entered
-- again if the new rate should apply.
create view payments_at_old_rate as
select e.id as entry_id,
       e.kind,
       e.happened_at,
       f.day,
       e.iqd_per_100_usd as used_rate,
       f.iqd_per_100_usd as day_rate
from journal_entries e
join fx_rates f on f.day = (e.happened_at at time zone 'Asia/Baghdad')::date
where e.kind in ('driver_collected', 'office_payment', 'wallet_payment')
  and e.iqd_per_100_usd is not null
  and e.iqd_per_100_usd <> f.iqd_per_100_usd
  and not exists (select 1 from journal_entries r where r.reverses_id = e.id);

-- ---------------------------------------------------------------------------
-- Payments, read from the ledger
-- ---------------------------------------------------------------------------

-- Every customer payment with how it was paid. Nothing is stored twice: the
-- method, the amount as received and the rate all come from the entry itself.
create view payments as
select e.id as entry_id,
       ca.customer_id,
       e.kind,
       (case m.kind
          when 'driver_cash' then 'driver_cash'
          when 'vault' then 'office_cash'
          else split_part(m.code, '_', 2)
        end)::payment_method as method,
       ml.amount as received_amount,
       ml.currency as received_currency,
       e.iqd_per_100_usd,
       -cl.amount as credited_usd_cents,
       e.happened_at,
       e.created_at,
       e.created_by,
       e.reason as note,
       m.round_id,
       t.consignment_id as paid_for_consignment_id,
       exists (select 1 from journal_entries r where r.reverses_id = e.id) as reversed
from journal_entries e
join journal_lines cl on cl.entry_id = e.id
join accounts ca on ca.id = cl.account_id and ca.kind = 'customer'
join journal_lines ml on ml.entry_id = e.id
join accounts m on m.id = ml.account_id and m.kind in ('vault', 'wallet', 'driver_cash')
left join payment_targets t on t.entry_id = e.id
where e.kind in ('driver_collected', 'office_payment', 'wallet_payment');

-- A receipt can belong to a payment made at the office, not only to a
-- consignment on a round.
alter table attachments
  alter column consignment_id drop not null,
  add column entry_id uuid references journal_entries (id),
  add constraint attachments_belongs_somewhere check (consignment_id is not null or entry_id is not null);

create index attachments_entry on attachments (entry_id) where entry_id is not null;

-- ---------------------------------------------------------------------------
-- The daily vault close
-- ---------------------------------------------------------------------------

create table vault_closes (
  id          uuid primary key,               -- sent by the caller; the same id twice is one close
  day         date not null,                  -- the Baghdad day it was counted on
  closed_at   timestamptz not null,
  closed_by   uuid not null,
  note        text,
  created_at  timestamptz not null default now(),
  voided_at   timestamptz,
  voided_by   uuid,
  void_reason text,
  constraint vault_closes_void_fields check (
    (voided_at is null) = (voided_by is null) and (voided_at is null) = (void_reason is null))
);

create index vault_closes_day on vault_closes (day);

alter table cash_counts
  add column vault_close_id uuid references vault_closes (id),
  add constraint cash_counts_vault_has_close check ((place = 'vault') = (vault_close_id is not null)),
  add constraint cash_counts_one_per_close unique (vault_close_id, currency);

-- What should be in the vault now, in one currency: what the ledger says,
-- plus every gap already found and noted at an earlier close. That is the
-- same as "the last count plus everything entered since".
create function gs_vault_expected(p_currency currency) returns bigint
language sql stable as $$
  select coalesce((select b.balance from accounts a join account_balances b on b.account_id = a.id
                   where a.kind = 'vault' and a.currency = p_currency), 0)
       + coalesce((select sum(c.difference) from cash_counts c join vault_closes v on v.id = c.vault_close_id
                   where c.place = 'vault' and c.currency = p_currency and v.voided_at is null), 0);
$$;

-- The CEO counts the vault note by note. The system adds it up and compares
-- it with what should be there. Any gap needs a note.
--
-- p_usd_notes, p_iqd_notes: {"10000": 3, "5000": 1} is three $100 notes and one $50.
create function gs_close_vault(
  p_id        uuid,
  p_user      uuid,
  p_closed_at timestamptz,
  p_usd_notes jsonb default null,
  p_iqd_notes jsonb default null,
  p_note      text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_counted_usd  bigint;
  v_counted_iqd  bigint;
  v_expected_usd bigint;
  v_expected_iqd bigint;
begin
  if p_id is null then
    raise exception 'close_id_required' using errcode = 'P0001';
  end if;
  if p_closed_at is null then
    raise exception 'closed_at_required: say when the vault was counted' using errcode = 'P0001';
  end if;
  -- One close at a time, so two never work from the same expected amount.
  perform pg_advisory_xact_lock(hashtextextended('gs_vault_close', 0));
  if exists (select 1 from vault_closes where id = p_id) then
    return p_id;   -- the same request again
  end if;

  if exists (select 1 from vault_closes where voided_at is null and closed_at > p_closed_at) then
    raise exception 'close_out_of_order: the vault was already counted at a later time than %', p_closed_at
      using errcode = 'P0001';
  end if;

  v_counted_usd := gs_count_notes('USD', p_usd_notes);
  v_counted_iqd := gs_count_notes('IQD', p_iqd_notes);
  v_expected_usd := gs_vault_expected('USD');
  v_expected_iqd := gs_vault_expected('IQD');

  if (v_counted_usd <> v_expected_usd or v_counted_iqd <> v_expected_iqd)
     and length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'gap_note_required: counted % USD cents and % IQD, expected % and %. Say why they differ.',
      v_counted_usd, v_counted_iqd, v_expected_usd, v_expected_iqd using errcode = 'P0001';
  end if;

  insert into vault_closes (id, day, closed_at, closed_by, note)
  values (p_id, (p_closed_at at time zone 'Asia/Baghdad')::date, p_closed_at, p_user, nullif(btrim(p_note), ''));

  insert into cash_counts (place, vault_close_id, currency, notes, counted, expected, counted_by) values
    ('vault', p_id, 'USD', coalesce(p_usd_notes, '{}'::jsonb), v_counted_usd, v_expected_usd, p_user),
    ('vault', p_id, 'IQD', coalesce(p_iqd_notes, '{}'::jsonb), v_counted_iqd, v_expected_iqd, p_user);
  return p_id;
end $$;

-- A close that was counted or typed wrong is taken back and counted again.
-- Only the latest close can be taken back: later ones were measured against it.
create function gs_void_vault_close(p_close_id uuid, p_user uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_close vault_closes%rowtype;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'reason_required: say why the close is taken back' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gs_vault_close', 0));
  select * into v_close from vault_closes where id = p_close_id for update;
  if not found then
    raise exception 'close_not_found: %', p_close_id using errcode = 'P0001';
  end if;
  if v_close.voided_at is not null then
    return;
  end if;
  if exists (select 1 from vault_closes v
             where v.voided_at is null and v.id <> p_close_id
               and (v.closed_at, v.created_at) > (v_close.closed_at, v_close.created_at)) then
    raise exception 'close_not_latest: only the latest close can be taken back' using errcode = 'P0001';
  end if;
  update vault_closes
     set voided_at = now(), voided_by = p_user, void_reason = btrim(p_reason)
   where id = p_close_id;
end $$;

-- The vault now, per currency: the ledger, the gaps already noted, what
-- should be in the box, and when it was last counted.
create view vault_status as
select a.currency,
       coalesce(b.balance, 0) as ledger_balance,
       gs_vault_expected(a.currency) - coalesce(b.balance, 0) as noted_gap,
       gs_vault_expected(a.currency) as expected_now,
       lc.id as last_close_id,
       lc.day as last_close_day,
       lc.closed_at as last_closed_at,
       lc.counted as last_counted,
       lc.difference as last_difference
from accounts a
left join account_balances b on b.account_id = a.id
left join lateral (
  select v.id, v.day, v.closed_at, c.counted, c.difference
  from vault_closes v join cash_counts c on c.vault_close_id = v.id and c.currency = a.currency
  where v.voided_at is null
  order by v.closed_at desc, v.created_at desc
  limit 1
) lc on true
where a.kind = 'vault';

-- Every close with both counts side by side.
create view vault_close_details as
select v.id as close_id,
       v.day,
       v.closed_at,
       v.closed_by,
       v.note,
       v.voided_at is not null as voided,
       u.notes as usd_notes, u.counted as usd_counted, u.expected as usd_expected, u.difference as usd_difference,
       i.notes as iqd_notes, i.counted as iqd_counted, i.expected as iqd_expected, i.difference as iqd_difference
from vault_closes v
join cash_counts u on u.vault_close_id = v.id and u.currency = 'USD'
join cash_counts i on i.vault_close_id = v.id and i.currency = 'IQD';

-- ---------------------------------------------------------------------------
-- The China account
-- ---------------------------------------------------------------------------

-- Every line on what is owed to the China office: each customer's charge when
-- a file is confirmed, and each amount sent. owed_change is positive when we
-- owe more and negative when it is paid down.
create view china_account as
select e.id as entry_id,
       e.happened_at,
       (e.happened_at at time zone 'Asia/Baghdad')::date as day,
       coalesce(o.kind, e.kind) as kind,
       e.reverses_id is not null as is_reversal,
       -l.amount as owed_change_usd_cents,
       sum(-l.amount) over (order by e.happened_at, e.created_at, l.id) as owed_after_usd_cents,
       s.code as shipment_code,
       c.customer_id,
       e.reason
from journal_lines l
join accounts a on a.id = l.account_id and a.kind = 'china_payable'
join journal_entries e on e.id = l.entry_id
left join journal_entries o on o.id = e.reverses_id
left join consignments c on c.charge_entry_id = coalesce(e.reverses_id, e.id)
left join shipments s on s.id = c.shipment_id;

-- The same by day: what the files added, what was sent, and what is owed
-- at the end of the day.
create view china_account_by_day as
select d.day,
       d.charged_usd_cents,
       d.sent_usd_cents,
       sum(d.charged_usd_cents - d.sent_usd_cents) over (order by d.day) as owed_after_usd_cents
from (
  select day,
         coalesce(sum(owed_change_usd_cents) filter (where kind = 'file_confirmed'), 0) as charged_usd_cents,
         -coalesce(sum(owed_change_usd_cents) filter (where kind = 'sent_to_china'), 0) as sent_usd_cents
  from china_account
  group by day
) d;

create view china_account_summary as
select coalesce(sum(owed_change_usd_cents), 0) as owed_usd_cents,
       coalesce(sum(owed_change_usd_cents) filter (where kind = 'file_confirmed'), 0) as charged_usd_cents,
       -coalesce(sum(owed_change_usd_cents) filter (where kind = 'sent_to_china'), 0) as sent_usd_cents
from china_account;

-- Cash paid out of the vault, by category, for the Money screen.
create view cash_outs as
select e.id as entry_id,
       e.happened_at,
       (e.happened_at at time zone 'Asia/Baghdad')::date as day,
       case when e.kind = 'sent_to_china' then 'china' else substring(x.code from '^expense_(.*)_(usd|iqd)$') end as category,
       -v.amount as amount,
       v.currency,
       e.reason,
       e.created_by,
       exists (select 1 from journal_entries r where r.reverses_id = e.id) as reversed
from journal_entries e
join journal_lines v on v.entry_id = e.id
join accounts va on va.id = v.account_id and va.kind = 'vault'
left join journal_lines xl on xl.entry_id = e.id and xl.id <> v.id
left join accounts x on x.id = xl.account_id
where e.kind in ('cash_out', 'sent_to_china');

-- ---------------------------------------------------------------------------
-- The application's role
-- ---------------------------------------------------------------------------

grant select on entry_shapes, fx_rate_changes, payments_at_old_rate, payments, vault_closes,
                vault_status, vault_close_details, china_account, china_account_by_day,
                china_account_summary, cash_outs
  to green_star_app;
