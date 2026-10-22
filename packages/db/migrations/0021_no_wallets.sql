-- No wallets. Tala, 22 October: "Remove FastPay and ZainCash" and "remove
-- wallet systems at all for now: it should be just like adding normal money
-- and then selecting how the money was paid".
--
-- 1. FastPay and ZainCash are not taken any more. Their accounts stay, so
--    the books keep what was ever paid that way, but nothing new goes in;
--    only taking an old entry back may touch them.
-- 2. FIB is just a way to pay. Its money still lands on its own account and
--    not in the vault, so the vault count stays right, but there is no
--    wallet check any more: no reading the app, no "wallet gap" and no
--    "wallet check due". Alerts of those kinds that are open end by
--    themselves on the next run.

create function gs_no_removed_methods() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (
    select 1
      from accounts a
      join journal_entries e on e.id = new.entry_id
     where a.id = new.account_id
       and a.code in ('wallet_fastpay_usd', 'wallet_fastpay_iqd', 'wallet_zaincash_usd', 'wallet_zaincash_iqd')
       and e.kind <> 'reversal'
  ) then
    raise exception 'method_removed: FastPay and ZainCash are not taken any more' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger journal_lines_no_removed_methods before insert on journal_lines
  for each row execute function gs_no_removed_methods();

-- The wallet check is gone: the app can no longer record one.
revoke execute on function gs_check_wallet(uuid, text, uuid, bigint, timestamptz, text) from public;

-- Everything that does not match, at the moment p_now, as in 0008 without the
-- two wallet checks.
create or replace function gs_current_problems(p_now timestamptz, p_deep boolean)
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
