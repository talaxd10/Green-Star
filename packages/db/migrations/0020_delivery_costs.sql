-- What delivery costs, exactly.
--
-- The CEO, October 2026: "China have no idea about Sulaymaniyah's expenses.
-- It's important to separate profit and expenses. They have an approximation
-- but they cannot track it exactly. If we can do something that tells us the
-- exact expenses... at a certain point if they see it's not too much, they
-- can expand the delivery side of the business by buying a second car."
--
-- Every expense is already in the ledger: paid from the vault (a cash out) or
-- by the driver from his own account (a receipt). This reads them all in one
-- list with what kind, which city and which round, counted in dollars at the
-- rate of the day, next to what was delivered in the same time: rounds,
-- customers' goods and kilograms. Nothing new is stored.

-- The rate to count dinars in dollars on a day: that day's, or the nearest
-- day before it, or after it when there is none before.
create function gs_rate_near(p_day date) returns integer
language sql stable as $$
  select iqd_per_100_usd from fx_rates order by (day > p_day), abs(day - p_day), day limit 1;
$$;

-- Every expense line, a reversal as a negative line, so sums are what stands.
create view expense_lines as
select e.id as entry_id,
       e.reverses_id,
       e.happened_at,
       (e.happened_at at time zone 'Asia/Baghdad')::date as day,
       c.code as category,
       c.label as category_label,
       c.delivery,
       l.currency,
       l.amount,
       case when l.currency = 'USD' then l.amount
            -- A reversal is the exact mirror, in dollars too.
            else sign(l.amount)::bigint
                 * coalesce(gs_iqd_to_usd_cents(abs(l.amount), gs_rate_near((e.happened_at at time zone 'Asia/Baghdad')::date)), 0)
       end as usd_cents,
       coalesce(d.city, od.city) as city,
       coalesce(d.round_id, od.round_id) as round_id,
       coalesce(d.driver_id, od.driver_id) as driver_id,
       case when coalesce(o.kind, e.kind) = 'driver_expense' then 'driver' else 'vault' end as paid_from,
       coalesce(e.reason, o.reason) as note
from journal_lines l
join accounts a on a.id = l.account_id and a.kind = 'expense'
join journal_entries e on e.id = l.entry_id
left join journal_entries o on o.id = e.reverses_id
join expense_categories c on c.code = substring(a.code from '^expense_(.*)_(usd|iqd)$')
left join expense_details d on d.entry_id = e.id
left join expense_details od on od.entry_id = e.reverses_id;

-- Goods handed over on a round: one row per customer's goods, with the
-- kilograms the file said and the city they went to.
create view delivered_goods as
select r.round_id,
       r.consignment_id,
       r.happened_at,
       (r.happened_at at time zone 'Asia/Baghdad')::date as day,
       coalesce(c.city, '') as city,
       coalesce((select sum(sl.weight_grams) from shipment_lines sl where sl.consignment_id = c.id), 0) as weight_grams
from round_results r
join consignments c on c.id = r.consignment_id
where r.voided_at is null and r.outcome <> 'held';

grant select on expense_lines, delivered_goods to green_star_app;
