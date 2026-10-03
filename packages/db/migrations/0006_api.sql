-- What the API needs from the database: the same "only the CEO, under his own
-- name" rule on every table outside the ledger, the audit log for those
-- tables, safe retries for every write, merging a duplicate customer, and the
-- lists the screens read.
--
-- What the database guarantees here:
--   1. Everything outside the ledger is changed only by a CEO, the same as
--      the ledger itself. The owner and the monitor can change nothing.
--   2. Wherever a row says who did something, it names the CEO who is acting.
--   3. Every change to customers, files, rounds and the people who carry them
--      is in the audit log with before and after.
--   4. A request sent twice with the same key is done once.
--   5. A duplicate customer can be merged into the real one only while it has
--      nothing on the books, and can be used for nothing afterwards.
--   6. A payment says which consignment it is for only while it is being
--      posted, and only for a consignment of the customer it credits.

-- ---------------------------------------------------------------------------
-- The audit log, for every table outside the ledger
-- ---------------------------------------------------------------------------

-- As before, with one more optional argument: columns that are worked out by
-- the system (a status), separated by commas. A change to those alone is not
-- a change a person made and is not logged.
--
--   for each row execute function gs_audit('ceo', 'id', 'status');
create or replace function gs_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor  uuid;
  v_before jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_after  jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_key    text := coalesce(tg_argv[1], 'id');
  v_ignore text[] := string_to_array(coalesce(tg_argv[2], ''), ',');
begin
  if gs_app_session() then
    if tg_argv[0] = 'ceo' then
      v_actor := gs_require_ceo();
    else
      v_actor := gs_require_actor();
    end if;
  else
    v_actor := gs_actor();
  end if;

  if tg_op = 'UPDATE' and (v_before - v_ignore) = (v_after - v_ignore) then
    return null;
  end if;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (v_actor, lower(tg_op), tg_table_name, coalesce(v_after, v_before) ->> v_key, v_before, v_after);
  return null;
end $$;

create trigger customers_audit after insert or update or delete on customers
  for each row execute function gs_audit('ceo');
create trigger customer_phones_audit after insert or update or delete on customer_phones
  for each row execute function gs_audit('ceo');
create trigger customer_marks_audit after insert or update or delete on customer_marks
  for each row execute function gs_audit('ceo');
create trigger customer_aliases_audit after insert or update or delete on customer_aliases
  for each row execute function gs_audit('ceo');
create trigger drivers_audit after insert or update or delete on drivers
  for each row execute function gs_audit('ceo');
create trigger carriers_audit after insert or update or delete on carriers
  for each row execute function gs_audit('ceo');
create trigger source_files_audit after insert or update or delete on source_files
  for each row execute function gs_audit('ceo');
create trigger shipments_audit after insert or update or delete on shipments
  for each row execute function gs_audit('ceo', 'id', 'status');
create trigger consignments_audit after insert or update or delete on consignments
  for each row execute function gs_audit('ceo', 'id', 'status');
create trigger disputes_audit after insert or update or delete on disputes
  for each row execute function gs_audit('ceo');
create trigger rounds_audit after insert or update or delete on rounds
  for each row execute function gs_audit('ceo', 'id', 'status,left_at,returned_at,handed_in_at');
create trigger round_stops_audit after insert or update or delete on round_stops
  for each row execute function gs_audit('ceo');
create trigger attachments_audit after insert or update or delete on attachments
  for each row execute function gs_audit('ceo');
create trigger exceptions_audit after insert or update or delete on exceptions
  for each row execute function gs_audit('ceo');

-- ---------------------------------------------------------------------------
-- Guard: a row names the CEO who is acting
-- ---------------------------------------------------------------------------

-- The tables below keep their own history (a result is voided, not edited; a
-- close is taken back, not changed), so they are not in the audit log. They
-- say who did each thing, and this makes that name true: for the application
-- it must be the CEO who is signed in.
--
--   for each row execute function gs_named_by_the_actor('entered_by', 'voided_by');
create function gs_named_by_the_actor() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid;
  v_col   text;
  v_new   jsonb := to_jsonb(new);
  v_old   jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
begin
  if not gs_app_session() then
    return new;
  end if;
  v_actor := gs_require_ceo();
  foreach v_col in array tg_argv loop
    if v_new ->> v_col is not null
       and (v_old is null or v_old ->> v_col is distinct from v_new ->> v_col)
       and (v_new ->> v_col)::uuid <> v_actor then
      raise exception 'actor_mismatch: % on % names % but % is acting', v_col, tg_table_name, v_new ->> v_col, v_actor
        using errcode = 'P0001';
    end if;
  end loop;
  return new;
end $$;

create trigger users_named before insert or update on users
  for each row execute function gs_named_by_the_actor('created_by');
create trigger fx_rates_named before insert or update on fx_rates
  for each row execute function gs_named_by_the_actor('set_by');
create trigger fx_rate_changes_named before insert on fx_rate_changes
  for each row execute function gs_named_by_the_actor('set_by');
create trigger customer_trust_changes_named before insert on customer_trust_changes
  for each row execute function gs_named_by_the_actor('changed_by');
create trigger source_files_named before insert or update on source_files
  for each row execute function gs_named_by_the_actor('uploaded_by');
create trigger shipments_named before insert or update on shipments
  for each row execute function gs_named_by_the_actor('confirmed_by');
create trigger disputes_named before insert or update on disputes
  for each row execute function gs_named_by_the_actor('created_by');
create trigger rounds_named before insert or update on rounds
  for each row execute function gs_named_by_the_actor('created_by');
create trigger round_stops_named before insert or update on round_stops
  for each row execute function gs_named_by_the_actor('added_by');
create trigger round_results_named before insert or update on round_results
  for each row execute function gs_named_by_the_actor('entered_by', 'voided_by');
create trigger attachments_named before insert or update on attachments
  for each row execute function gs_named_by_the_actor('uploaded_by');
create trigger exceptions_named before insert or update on exceptions
  for each row execute function gs_named_by_the_actor('approved_by');
create trigger round_hand_ins_named before insert or update on round_hand_ins
  for each row execute function gs_named_by_the_actor('handed_in_by', 'voided_by');
create trigger cash_counts_named before insert on cash_counts
  for each row execute function gs_named_by_the_actor('counted_by');
create trigger vault_closes_named before insert or update on vault_closes
  for each row execute function gs_named_by_the_actor('closed_by', 'voided_by');

-- ---------------------------------------------------------------------------
-- A request sent twice is done once
-- ---------------------------------------------------------------------------

-- Every write the office app sends carries a key it made up for that one
-- click on Save. The API records the key in the same transaction as the
-- change. If the same key arrives again (a double click, a retry after the
-- connection dropped), the first answer is sent back and nothing is done.
create table api_requests (
  key          text primary key,
  user_id      uuid not null references users (id),
  method       text not null,
  path         text not null,
  request_hash bytea not null,           -- sha256 of what was sent
  status       integer,                  -- what was answered
  response     jsonb,
  created_at   timestamptz not null default now(),
  constraint api_requests_key_format check (key ~ '^[A-Za-z0-9._:-]{8,200}$'),
  constraint api_requests_hash_is_sha256 check (octet_length(request_hash) = 32)
);

create index api_requests_created_at on api_requests (created_at);

-- An answer is recorded once and the rest of the row never changes.
create function gs_api_requests_guard() returns trigger
language plpgsql as $$
begin
  if (new.key, new.user_id, new.method, new.path, new.request_hash, new.created_at)
     is distinct from (old.key, old.user_id, old.method, old.path, old.request_hash, old.created_at)
     or old.status is not null then
    raise exception 'request_locked: a recorded request cannot change' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger api_requests_guard before update on api_requests
  for each row execute function gs_api_requests_guard();

-- ---------------------------------------------------------------------------
-- A payment at the office can name the consignment it is for
-- ---------------------------------------------------------------------------

-- Until now only a round result could say which consignment its money was
-- for: gs_post_entry wrote the target itself, and the application has no
-- right to write that table. This does it on the application's behalf, with
-- the same check, and only while the entry is being posted, so an old
-- payment can never be pointed somewhere else afterwards.
create function gs_set_payment_target(p_entry_id uuid, p_consignment_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from journal_entries e where e.id = p_entry_id and e.created_at = now()) then
    raise exception 'entry_closed: a payment says what it is for only while it is being posted' using errcode = 'P0001';
  end if;
  if not exists (
    select 1
    from journal_lines l
    join accounts a on a.id = l.account_id and a.kind = 'customer'
    join consignments c on c.customer_id = a.customer_id
    where l.entry_id = p_entry_id and c.id = p_consignment_id and l.amount < 0
  ) then
    raise exception 'target_invalid: a payment can only be made for a consignment of the customer it credits'
      using errcode = 'P0001';
  end if;
  insert into payment_targets (entry_id, consignment_id) values (p_entry_id, p_consignment_id);
end $$;

-- gs_post_entry, unchanged except that the target goes through the function above.
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

  -- Run the commit-time checks now, so the caller gets the error here.
  set constraints journal_lines_balanced, journal_entries_complete immediate;
  set constraints journal_lines_balanced, journal_entries_complete deferred;

  if p_for_consignment is not null then
    perform gs_set_payment_target(v_id, p_for_consignment);
  end if;

  perform gs_allocate_customer(t.customer_id)
  from (select distinct a.customer_id
        from journal_lines l join accounts a on a.id = l.account_id
        where l.entry_id = v_id and a.kind = 'customer'
        order by a.customer_id) t;

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Merging a duplicate customer
-- ---------------------------------------------------------------------------

alter table customers
  add column merged_into uuid references customers (id),
  add constraint customers_not_merged_into_itself check (merged_into is distinct from id);

-- A merged customer stays as a row, because the audit log names it, and is
-- used for nothing: no phones, marks, names or goods.
create function gs_customer_not_merged() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from customers where id = new.customer_id and merged_into is not null) then
    raise exception 'customer_merged: this customer was merged into another one' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger customer_phones_not_merged before insert or update on customer_phones
  for each row execute function gs_customer_not_merged();
create trigger customer_marks_not_merged before insert or update on customer_marks
  for each row execute function gs_customer_not_merged();
create trigger customer_aliases_not_merged before insert or update on customer_aliases
  for each row execute function gs_customer_not_merged();
create trigger consignments_not_merged before insert or update of customer_id on consignments
  for each row execute function gs_customer_not_merged();

-- Merges a customer made by mistake into the real one: his phones, marks,
-- names and the goods on files not yet confirmed move over.
--
-- Only while the duplicate has nothing on the books. Charges and payments
-- are never moved from one account to another, so a duplicate that already
-- has either is fixed the way every money mistake is: reversed and entered
-- again under the right customer.
create function gs_merge_customer(p_from uuid, p_into uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_from customers%rowtype;
  v_into customers%rowtype;
begin
  if p_from = p_into then
    raise exception 'merge_invalid: a customer cannot be merged into himself' using errcode = 'P0001';
  end if;
  perform gs_lock_customers(array[p_from, p_into]);
  select * into v_from from customers where id = p_from for update;
  select * into v_into from customers where id = p_into for update;
  if v_from.id is null or v_into.id is null then
    raise exception 'customer_not_found: %', case when v_from.id is null then p_from else p_into end using errcode = 'P0001';
  end if;
  if v_from.merged_into is not null or v_into.merged_into is not null then
    raise exception 'customer_merged: one of the two was already merged' using errcode = 'P0001';
  end if;
  if exists (select 1 from accounts a join journal_lines l on l.account_id = a.id where a.customer_id = p_from)
     or exists (select 1 from consignments c join shipments s on s.id = c.shipment_id
                where c.customer_id = p_from and s.status <> 'draft') then
    raise exception 'merge_has_history: % already has goods or money on the books. Fix those under the right customer first.',
      v_from.display_name using errcode = 'P0001';
  end if;
  if exists (select 1 from consignments a join consignments b on b.shipment_id = a.shipment_id
             where a.customer_id = p_from and b.customer_id = p_into
               and a.status <> 'cancelled' and b.status <> 'cancelled') then
    raise exception 'merge_conflict: both are on the same file. Remove one of the two rows first.' using errcode = 'P0001';
  end if;

  update customer_phones set customer_id = p_into,
         is_primary = is_primary and not exists (select 1 from customer_phones p where p.customer_id = p_into and p.is_primary)
   where customer_id = p_from;
  update customer_marks set customer_id = p_into where customer_id = p_from;
  delete from customer_aliases a
   where a.customer_id = p_from
     and exists (select 1 from customer_aliases b where b.customer_id = p_into and b.alias = a.alias);
  update customer_aliases set customer_id = p_into where customer_id = p_from;
  insert into customer_aliases (customer_id, alias) values (p_into, v_from.display_name)
  on conflict (customer_id, alias) do nothing;
  update consignments set customer_id = p_into where customer_id = p_from;

  update customers set merged_into = p_into where id = p_from;
end $$;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

-- One line per customer for the Customers screen: balance, trust, limit,
-- and how to find him.
create view customer_overview as
select c.id as customer_id,
       c.display_name,
       c.kind,
       c.trust,
       c.credit_limit_usd_cents,
       c.created_at,
       coalesce(b.balance_usd_cents, 0) as balance_usd_cents,
       (c.trust = 'trusted' and c.credit_limit_usd_cents is not null
        and coalesce(b.balance_usd_cents, 0) > c.credit_limit_usd_cents) as over_limit,
       (select p.phone from customer_phones p where p.customer_id = c.id
        order by p.is_primary desc, p.created_at, p.id limit 1) as phone,
       coalesce((select array_agg(p.phone order by p.is_primary desc, p.created_at, p.id)
                 from customer_phones p where p.customer_id = c.id), '{}') as phones,
       coalesce((select array_agg(m.mark order by m.mark) from customer_marks m where m.customer_id = c.id), '{}') as marks,
       (select count(*) from consignment_money cm where cm.customer_id = c.id and cm.remaining_usd_cents > 0) as unpaid_consignments
from customers c
left join customer_balances b on b.customer_id = c.id
where c.merged_into is null;

-- One line per file for the Files screen: what was expected, what came in,
-- and what stops it closing.
create view shipment_overview as
select s.id as shipment_id,
       s.code,
       s.status,
       s.arrived_on,
       s.confirmed_at,
       s.created_at,
       n.consignments,
       n.expected_usd_cents,
       n.collected_usd_cents,
       n.expected_usd_cents - n.collected_usd_cents as remaining_usd_cents,
       n.not_delivered,                 -- listed, on a round, or held in the car
       n.delivered_not_paid,            -- pay-first customers who have the goods and still owe
       n.on_account,                    -- trusted customers who have the goods and still owe
       n.waiting_for_hand_in,           -- delivered, but that round's cash is not counted in yet
       (select count(*) from disputes d join consignments dc on dc.id = d.consignment_id
        where dc.shipment_id = s.id and d.status in ('open', 'sent_to_china')) as disputes_waiting
from shipments s
cross join lateral (
  select count(*) as consignments,
         coalesce(sum(cm.due_usd_cents), 0) as expected_usd_cents,
         coalesce(sum(cm.paid_usd_cents), 0) as collected_usd_cents,
         count(*) filter (where c.status in ('listed', 'on_round', 'held')) as not_delivered,
         count(*) filter (where c.status = 'delivered_not_paid') as delivered_not_paid,
         count(*) filter (where c.status = 'delivered_on_account') as on_account,
         count(*) filter (where c.status in ('delivered_paid', 'delivered_prepaid', 'delivered_on_account', 'delivered_not_paid')
                            and ls.round_status is distinct from 'handed_in') as waiting_for_hand_in
  from consignments c
  join consignment_money cm on cm.consignment_id = c.id
  left join consignment_last_stop ls on ls.consignment_id = c.id
  where c.shipment_id = s.id and c.status <> 'cancelled'
) n;

-- Every consignment as the screens show it: who, which file, what is owed.
create view consignment_details as
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
       exists (select 1 from exceptions x where x.consignment_id = c.id) as has_exception
from consignments c
join shipments s on s.id = c.shipment_id
join customers cu on cu.id = c.customer_id
join consignment_money cm on cm.consignment_id = c.id
left join consignment_last_stop ls on ls.consignment_id = c.id;

-- Every account with what is on it now.
create view account_overview as
select a.id as account_id,
       a.code,
       a.kind,
       a.currency,
       a.name,
       a.customer_id,
       a.round_id,
       coalesce(b.balance, 0) as balance
from accounts a
left join account_balances b on b.account_id = a.id;

-- ---------------------------------------------------------------------------
-- The application's role
-- ---------------------------------------------------------------------------

grant select on customer_overview, shipment_overview, consignment_details, account_overview to green_star_app;
grant select, insert (key, user_id, method, path, request_hash), update (status, response) on api_requests to green_star_app;
