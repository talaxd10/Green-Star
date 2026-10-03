-- The China account, with each line's place in it.
--
-- The view already works out what is owed after every line, in the order the
-- money moved. A screen that lists the lines has to show them in that same
-- order, or "owed after" appears to jump about. `position` is that order:
-- 1 is the first line ever, and the highest is the latest.

create or replace view china_account as
select e.id as entry_id,
       e.happened_at,
       (e.happened_at at time zone 'Asia/Baghdad')::date as day,
       coalesce(o.kind, e.kind) as kind,
       e.reverses_id is not null as is_reversal,
       -l.amount as owed_change_usd_cents,
       sum(-l.amount) over (order by e.happened_at, e.created_at, l.id) as owed_after_usd_cents,
       s.code as shipment_code,
       c.customer_id,
       e.reason,
       row_number() over (order by e.happened_at, e.created_at, l.id) as position
from journal_lines l
join accounts a on a.id = l.account_id and a.kind = 'china_payable'
join journal_entries e on e.id = l.entry_id
left join journal_entries o on o.id = e.reverses_id
left join consignments c on c.charge_entry_id = coalesce(e.reverses_id, e.id)
left join shipments s on s.id = c.shipment_id;
