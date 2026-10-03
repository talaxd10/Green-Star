-- Checks and alerts: everything that does not match, in one list.
--
-- What the database guarantees here:
--   1. What is wrong is worked out from the facts every time (one function,
--      gs_current_problems), never typed in. An alert is that function's
--      answer written down, so there is a record of when it started, who
--      dealt with it and what he wrote.
--   2. One thing that is wrong is one alert, however often the checks run.
--   3. An alert ends in one of two ways: the CEO resolves it with a note, or
--      the facts change and it goes away by itself. Nothing else closes one,
--      and nothing deletes one.
--   4. A resolved alert stays resolved while the same thing is still wrong.
--      If it stops being wrong and happens again, that is a new alert.
--   5. The office settings are one row, changed only by the CEO, and every
--      change is in the audit log.
--   6. A wallet is checked against its app the way the vault is counted: a
--      gap needs a note, and a check is never edited.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- The widgets the office monitor can show. None of them shows money.
create function gs_widgets_valid(p_widgets text[]) returns boolean
language sql immutable as $$
  select p_widgets is not null
     and p_widgets <@ array['files', 'rounds', 'held']
     and cardinality(p_widgets) = (select count(distinct w) from unnest(p_widgets) w);
$$;

create table settings (
  id                smallint primary key default 1,
  held_in_car_days  integer not null default 3,            -- goods held longer than this raise an alert
  vault_close_time  time not null default '18:00',         -- Baghdad time; the reminder starts here
  wallet_check_days integer not null default 7,            -- how long wallet money may go unchecked
  monitor_widgets   text[] not null default '{files,rounds,held}',   -- what the office screen shows, in order
  updated_at        timestamptz not null default now(),
  constraint settings_one_row check (id = 1),
  constraint settings_held_days check (held_in_car_days between 1 and 60),
  constraint settings_wallet_days check (wallet_check_days between 1 and 60),
  constraint settings_widgets check (gs_widgets_valid(monitor_widgets))
);

insert into settings default values;

create trigger settings_no_delete before delete on settings
  for each row execute function gs_forbid_change();
create trigger settings_no_truncate before truncate on settings
  for each statement execute function gs_forbid_change();
create trigger settings_audit after insert or update on settings
  for each row execute function gs_audit('ceo', 'id', 'updated_at');

-- ---------------------------------------------------------------------------
-- The wallet check
-- ---------------------------------------------------------------------------

-- Wallet money never passes through the vault, so it has its own check: the
-- CEO reads the balance in the wallet's app and types it in.
create table wallet_checks (
  id          uuid primary key,              -- sent by the caller; the same id twice is one check
  account_id  uuid not null references accounts (id),
  currency    currency not null,
  app_balance bigint not null,               -- what the wallet's app shows
  expected    bigint not null,               -- what the books say it should show
  difference  bigint generated always as (app_balance - expected) stored,
  note        text,
  checked_at  timestamptz not null,
  checked_by  uuid not null references users (id),
  created_at  timestamptz not null default now(),
  constraint wallet_checks_balance_not_negative check (app_balance >= 0),
  constraint wallet_checks_gap_has_note check (app_balance = expected or length(btrim(coalesce(note, ''))) > 0)
);

create index wallet_checks_account on wallet_checks (account_id, created_at);

create trigger wallet_checks_no_change before update or delete on wallet_checks
  for each row execute function gs_forbid_change();
create trigger wallet_checks_no_truncate before truncate on wallet_checks
  for each statement execute function gs_forbid_change();
create trigger wallet_checks_named before insert on wallet_checks
  for each row execute function gs_named_by_the_actor('checked_by');

-- What a wallet's app should show now: what the ledger says, plus every gap
-- already found and noted at an earlier check. The same rule as the vault:
-- the last reading plus everything entered since.
create function gs_wallet_expected(p_account_id uuid) returns bigint
language sql stable as $$
  select coalesce((select b.balance from account_balances b where b.account_id = p_account_id), 0)
       + coalesce((select sum(c.difference) from wallet_checks c where c.account_id = p_account_id), 0);
$$;

-- Records one check of one wallet. p_account is the wallet's code, such as
-- wallet_fib_iqd. A gap needs a note.
create function gs_check_wallet(
  p_id          uuid,
  p_account     text,
  p_user        uuid,
  p_app_balance bigint,
  p_checked_at  timestamptz,
  p_note        text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_account  accounts%rowtype;
  v_existing wallet_checks%rowtype;
  v_expected bigint;
begin
  if p_id is null then
    raise exception 'check_id_required' using errcode = 'P0001';
  end if;
  if p_checked_at is null then
    raise exception 'checked_at_required: say when the app was read' using errcode = 'P0001';
  end if;
  if p_app_balance is null or p_app_balance < 0 then
    raise exception 'balance_invalid: the balance in the app is zero or more' using errcode = 'P0001';
  end if;
  select * into v_account from accounts where code = p_account and kind = 'wallet';
  if not found then
    raise exception 'wallet_not_found: %', p_account using errcode = 'P0001';
  end if;

  -- One check of a wallet at a time, so two never work from the same expected amount.
  perform pg_advisory_xact_lock(hashtextextended('gs_wallet_check:' || v_account.id::text, 0));
  select * into v_existing from wallet_checks where id = p_id;
  if found then
    if v_existing.account_id <> v_account.id then
      raise exception 'check_id_reused: this id belongs to another wallet' using errcode = 'P0001';
    end if;
    return p_id;   -- the same request again
  end if;

  v_expected := gs_wallet_expected(v_account.id);
  if p_app_balance <> v_expected and length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'gap_note_required: the app shows %, the books say %. Say why they differ.', p_app_balance, v_expected
      using errcode = 'P0001';
  end if;

  insert into wallet_checks (id, account_id, currency, app_balance, expected, note, checked_at, checked_by)
  values (p_id, v_account.id, v_account.currency, p_app_balance, v_expected, nullif(btrim(p_note), ''), p_checked_at, p_user);
  return p_id;
end $$;

-- Each wallet now: what the books say, what its app should show, when it was
-- last checked, and the oldest money that has come in since.
create view wallet_status as
select a.id as account_id,
       a.code,
       a.name,
       a.currency,
       split_part(a.code, '_', 2) as method,
       coalesce(b.balance, 0) as ledger_balance,
       gs_wallet_expected(a.id) as expected_in_app,
       lc.id as last_check_id,
       lc.checked_at as last_checked_at,
       lc.app_balance as last_app_balance,
       lc.difference as last_difference,
       (select min(e.created_at)
        from journal_lines l join journal_entries e on e.id = l.entry_id
        where l.account_id = a.id and e.created_at > coalesce(lc.created_at, '-infinity'::timestamptz)) as unchecked_since
from accounts a
left join account_balances b on b.account_id = a.id
left join lateral (
  select c.id, c.checked_at, c.created_at, c.app_balance, c.difference
  from wallet_checks c where c.account_id = a.id
  order by c.created_at desc, c.id desc limit 1
) lc on true
where a.kind = 'wallet';

-- ---------------------------------------------------------------------------
-- Alerts
-- ---------------------------------------------------------------------------

create type alert_kind as enum (
  'missed_collection',     -- a pay-first customer got the goods without paying in full. His top alert
  'round_cash_gap',        -- a round's cash was counted in and does not match its receipts
  'vault_gap',             -- the vault was counted and does not match
  'vault_not_closed',      -- cash moved and the vault was not counted by closing time
  'carton_mismatch',       -- cartons counted at the airport differ from the file
  'over_limit',            -- a trusted customer owes more than his own limit
  'held_too_long',         -- goods held in the car longer than the set number of days
  'wallet_gap',            -- a wallet's app showed something else than the books
  'wallet_check_due',      -- wallet money has gone unchecked for longer than the set number of days
  'payment_at_old_rate',   -- a dinar payment stands at a rate the day no longer has
  'books_out_of_step'      -- the ledger's own health check found something
);

create type alert_severity as enum ('high', 'medium', 'low');
create type alert_status as enum ('open', 'resolved', 'cleared');

create table alerts (
  id             uuid primary key default gen_random_uuid(),
  kind           alert_kind not null,
  severity       alert_severity not null,
  subject        text not null,              -- what it is about: a consignment, a round and a currency, a day
  title          text not null,              -- one line a person can read
  customer_id    uuid references customers (id),
  consignment_id uuid references consignments (id),
  shipment_id    uuid references shipments (id),
  round_id       uuid references rounds (id),
  amount         bigint,
  currency       currency,
  status         alert_status not null default 'open',
  active         boolean not null default true,   -- true while the thing is still wrong
  opened_at      timestamptz not null default now(),
  resolved_at    timestamptz,
  resolved_by    uuid references users (id),
  note           text,
  cleared_at     timestamptz,                -- when it stopped being wrong
  constraint alerts_subject_not_blank check (length(btrim(subject)) > 0),
  constraint alerts_title_not_blank check (length(btrim(title)) > 0),
  constraint alerts_amount_with_currency check ((amount is null) = (currency is null)),
  constraint alerts_resolved_fields check (
    (status = 'resolved') = (resolved_at is not null)
    and (resolved_at is null) = (resolved_by is null)
    and (resolved_at is null) = (note is null)),
  constraint alerts_note_not_blank check (note is null or length(btrim(note)) > 0),
  constraint alerts_cleared_fields check ((cleared_at is null) = active),
  constraint alerts_open_is_active check (status <> 'open' or active),
  constraint alerts_cleared_is_not_active check (status <> 'cleared' or not active)
);

-- One thing that is wrong is one alert.
create unique index alerts_one_active on alerts (kind, subject) where active;
create index alerts_status on alerts (status, opened_at);

-- An alert is never deleted, what it was about never changes, and what the
-- CEO wrote when he resolved it stays as he wrote it.
create function gs_alerts_guard() returns trigger
language plpgsql as $$
begin
  if (new.id, new.kind, new.subject, new.opened_at, new.customer_id, new.consignment_id, new.shipment_id, new.round_id)
     is distinct from
     (old.id, old.kind, old.subject, old.opened_at, old.customer_id, old.consignment_id, old.shipment_id, old.round_id) then
    raise exception 'alert_locked: what an alert is about cannot change' using errcode = 'P0001';
  end if;
  if old.status = 'resolved'
     and (new.status, new.resolved_at, new.resolved_by, new.note, new.title, new.amount)
         is distinct from (old.status, old.resolved_at, old.resolved_by, old.note, old.title, old.amount) then
    raise exception 'alert_locked: a resolved alert stays as it was resolved' using errcode = 'P0001';
  end if;
  if old.status = 'cleared' and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'alert_locked: an alert that went away cannot change' using errcode = 'P0001';
  end if;
  if not old.active and new.active then
    raise exception 'alert_locked: an alert that ended does not start again' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger alerts_guard before update on alerts
  for each row execute function gs_alerts_guard();
create trigger alerts_no_delete before delete on alerts
  for each row execute function gs_forbid_change();
create trigger alerts_no_truncate before truncate on alerts
  for each statement execute function gs_forbid_change();

-- $1,250.00 or 1,250,000 IQD. The sign is left to the sentence around it.
create function gs_money_text(p_amount numeric, p_currency currency) returns text
language sql immutable as $$
  select case p_currency
    when 'USD' then '$' || to_char(abs(p_amount) / 100.0, 'FM999,999,999,999,990.00')
    else to_char(abs(p_amount), 'FM999,999,999,999,999,990') || ' IQD'
  end;
$$;

-- Everything that does not match, at the moment p_now. One row per thing.
-- p_deep also runs the ledger's own health check, which reads every line in
-- the books: the worker asks for it on a timer, a single save does not.
create function gs_current_problems(p_now timestamptz, p_deep boolean)
returns table (
  kind alert_kind, severity alert_severity, subject text, title text,
  customer_id uuid, consignment_id uuid, shipment_id uuid, round_id uuid,
  amount bigint, currency currency)
language sql stable as $$
  -- The driver forgot to collect.
  select 'missed_collection'::alert_kind, 'high'::alert_severity, m.consignment_id::text,
         'Round ' || m.round_number || ': ' || m.customer_name || ' got the goods and '
           || gs_money_text(m.short_by_usd_cents, 'USD') || ' was not collected',
         m.customer_id, m.consignment_id, c.shipment_id, m.round_id, m.short_by_usd_cents::bigint, 'USD'::currency
  from missed_collections m
  join consignments c on c.id = m.consignment_id

  union all
  -- A round's cash was counted in and does not match its receipts.
  select 'round_cash_gap', 'high', rc.round_id::text || ':' || rc.currency::text,
         'Round ' || rd.number || ': the cash handed in is ' || gs_money_text(rc.gap, rc.currency)
           || case when rc.gap > 0 then ' short' else ' over' end,
         null, null, null, rc.round_id, rc.gap::bigint, rc.currency
  from round_cash rc
  join rounds rd on rd.id = rc.round_id
  where rd.status = 'handed_in' and rc.gap <> 0

  union all
  -- The vault was counted and does not match.
  select 'vault_gap', 'high', v.id::text || ':' || cc.currency::text,
         'Vault count of ' || to_char(v.day, 'FMDD Mon') || ': ' || gs_money_text(cc.difference, cc.currency)
           || case when cc.difference < 0 then ' short' else ' over' end,
         null, null, null, null, cc.difference, cc.currency
  from vault_closes v
  join cash_counts cc on cc.vault_close_id = v.id
  where v.voided_at is null and cc.difference <> 0

  union all
  -- Cash moved in or out of the vault and it was not counted by closing time.
  -- Money that moves after closing time belongs to the next day's count.
  select 'vault_not_closed', 'medium', d.day::text,
         'The vault has not been counted since ' || to_char(d.day, 'FMDD Mon'),
         null, null, null, null, null, null
  from (
    select min(e.created_at) as at
    from journal_entries e
    where e.created_at > coalesce((select max(v.created_at) from vault_closes v where v.voided_at is null), '-infinity'::timestamptz)
      and exists (select 1 from journal_lines l join accounts a on a.id = l.account_id
                  where l.entry_id = e.id and a.kind = 'vault')
  ) f
  cross join settings st
  cross join lateral (
    select case when f.at > (((f.at at time zone 'Asia/Baghdad')::date + st.vault_close_time) at time zone 'Asia/Baghdad')
                then (f.at at time zone 'Asia/Baghdad')::date + 1
                else (f.at at time zone 'Asia/Baghdad')::date end as day
  ) d
  where f.at is not null
    and p_now >= ((d.day + st.vault_close_time) at time zone 'Asia/Baghdad')

  union all
  -- Cartons counted at the airport differ from the file, and China has not been told.
  select 'carton_mismatch', 'medium', m.consignment_id::text,
         s.code || ': ' || cu.display_name || ' has ' || m.cartons_received || ' cartons, the file says ' || m.cartons_expected,
         m.customer_id, m.consignment_id, m.shipment_id, null, null, null
  from carton_mismatches m
  join shipments s on s.id = m.shipment_id
  join customers cu on cu.id = m.customer_id
  where not exists (select 1 from disputes d where d.consignment_id = m.consignment_id and d.kind = 'missing')

  union all
  -- A trusted customer owes more than his own limit.
  select 'over_limit', 'medium', o.customer_id::text,
         o.display_name || ' owes ' || gs_money_text(o.balance_usd_cents, 'USD') || ', '
           || gs_money_text(o.over_by_usd_cents, 'USD') || ' over the limit',
         o.customer_id, null, null, null, o.over_by_usd_cents::bigint, 'USD'
  from customers_over_limit o

  union all
  -- Goods held in the car longer than the set number of days.
  select 'held_too_long', 'medium', h.consignment_id::text,
         cu.display_name || '''s goods from ' || s.code || ' have been in the car for '
           || floor(extract(epoch from p_now - h.held_since) / 86400)::int || ' days',
         h.customer_id, h.consignment_id, h.shipment_id, h.round_id, null, null
  from held_in_car h
  join customers cu on cu.id = h.customer_id
  join shipments s on s.id = h.shipment_id
  cross join settings st
  where h.held_since is not null
    and p_now - h.held_since >= make_interval(days => st.held_in_car_days)

  union all
  -- A wallet's app showed something else than the books.
  select 'wallet_gap', 'high', wc.id::text,
         a.name || ': the app shows ' || gs_money_text(wc.difference, wc.currency)
           || case when wc.difference < 0 then ' less' else ' more' end || ' than the books',
         null, null, null, null, wc.difference, wc.currency
  from wallet_checks wc
  join accounts a on a.id = wc.account_id
  where wc.difference <> 0

  union all
  -- Wallet money that nobody has checked against the app for too long.
  select 'wallet_check_due', 'low', w.code,
         w.name || ' has not been checked against its app for '
           || floor(extract(epoch from p_now - w.unchecked_since) / 86400)::int || ' days',
         null, null, null, null, null, null
  from wallet_status w
  cross join settings st
  where w.unchecked_since is not null
    and p_now - w.unchecked_since >= make_interval(days => st.wallet_check_days)

  union all
  -- A dinar payment was posted before the day's rate was changed.
  select 'payment_at_old_rate', 'medium', o.entry_id::text,
         cu.display_name || ' paid ' || gs_money_text(p.received_amount, p.received_currency) || ' on '
           || to_char(o.day, 'FMDD Mon') || ' at ' || to_char(o.used_rate, 'FM999,999,999') || ', and the day''s rate is now '
           || to_char(o.day_rate, 'FM999,999,999'),
         p.customer_id, p.paid_for_consignment_id, null, p.round_id, p.received_amount::bigint, p.received_currency
  from payments_at_old_rate o
  join payments p on p.entry_id = o.entry_id
  join customers cu on cu.id = p.customer_id

  union all
  -- The ledger's own health check.
  select 'books_out_of_step', 'high', left(hc.problem || ' ' || hc.detail, 400),
         'The books are out of step: ' || replace(hc.problem, '_', ' '),
         null, null, null, null, null, null
  from gs_ledger_health() hc
  where p_deep;
$$;

-- Brings the alerts in line with what is wrong at p_now: opens an alert for
-- each new thing, ends the ones that are no longer true, and keeps the wording
-- of the open ones up to date. Returns how many were opened.
--
-- Only the schema owner can name the moment. The application calls
-- gs_sync_alerts, which is always now.
create function gs_sync_alerts_at(p_now timestamptz, p_deep boolean) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_opened integer;
begin
  -- One at a time: two saves that end together would otherwise both open the same alert.
  perform pg_advisory_xact_lock(hashtextextended('gs_alerts', 0));

  with wrong as materialized (
    select distinct on (p.kind, p.subject) p.* from gs_current_problems(p_now, p_deep) p
    order by p.kind, p.subject
  ),
  ended as (
    update alerts a
       set active = false,
           cleared_at = now(),
           status = case when a.status = 'open' then 'cleared'::alert_status else a.status end
     where a.active
       and (p_deep or a.kind <> 'books_out_of_step')
       and not exists (select 1 from wrong w where w.kind = a.kind and w.subject = a.subject)
    returning 1
  ),
  reworded as (
    update alerts a
       set title = w.title, amount = w.amount, currency = w.currency, severity = w.severity
      from wrong w
     where a.active and a.status = 'open' and a.kind = w.kind and a.subject = w.subject
       and (a.title, a.amount, a.currency, a.severity) is distinct from (w.title, w.amount, w.currency, w.severity)
    returning 1
  ),
  opened as (
    insert into alerts (kind, severity, subject, title, customer_id, consignment_id, shipment_id, round_id, amount, currency)
    select w.kind, w.severity, w.subject, w.title, w.customer_id, w.consignment_id, w.shipment_id, w.round_id, w.amount, w.currency
    from wrong w
    where not exists (select 1 from alerts a where a.active and a.kind = w.kind and a.subject = w.subject)
    returning 1
  )
  select count(*) into v_opened from opened;
  return v_opened;
end $$;

revoke execute on function gs_sync_alerts_at(timestamptz, boolean) from public;

create function gs_sync_alerts(p_deep boolean default false) returns integer
language sql security definer set search_path = public, pg_temp as $$
  select gs_sync_alerts_at(now(), p_deep);
$$;

-- The CEO closes an alert with a note saying what was done about it.
create function gs_resolve_alert(p_alert_id uuid, p_user uuid, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_alert alerts%rowtype;
begin
  if gs_app_session() and gs_require_ceo() is distinct from p_user then
    raise exception 'actor_mismatch: resolved_by on alerts names % but % is acting', p_user, gs_actor()
      using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'note_required: say what was done about it' using errcode = 'P0001';
  end if;
  -- The same lock the checks take, and taken first, so resolving an alert and
  -- a check that rewords it never wait on each other.
  perform pg_advisory_xact_lock(hashtextextended('gs_alerts', 0));
  select * into v_alert from alerts where id = p_alert_id for update;
  if not found then
    raise exception 'alert_not_found: %', p_alert_id using errcode = 'P0001';
  end if;
  if v_alert.status = 'resolved' then
    return;   -- the same request again
  end if;
  if v_alert.status = 'cleared' then
    raise exception 'alert_not_open: this alert went away by itself' using errcode = 'P0001';
  end if;
  update alerts
     set status = 'resolved', resolved_at = now(), resolved_by = p_user, note = btrim(p_note)
   where id = p_alert_id;
end $$;

-- ---------------------------------------------------------------------------
-- The application's role
-- ---------------------------------------------------------------------------

grant select on settings, wallet_checks, wallet_status, alerts to green_star_app;
grant update (held_in_car_days, vault_close_time, wallet_check_days, monitor_widgets, updated_at) on settings to green_star_app;
