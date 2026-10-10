-- A file that arrives is shared out: trusted customers and pay-first ones.
--
-- The CEO, October 2026: "When a file arrives it distributes between trusted
-- customers and non-trusted customers. Non-trusted customers have to pay or
-- they don't get their item, and the trusted ones automatically in the file
-- are counted as if they have paid. In the account tab they get -500, so 500
-- in debt, or if they had a balance, their balance -500. That's the way a
-- file is handled, and after these steps you can call this file confirmed."
--
-- That is what confirming a file has done since the start: one charge per
-- customer, and goods go on account only for a trusted customer. What is new
-- is that the screens can show the split: who it was, as the file was
-- confirmed (trust_at_time), and each customer's account now, so the confirm
-- step shows a trusted customer's account before and after.

create or replace view consignment_details as
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
       exists (select 1 from exceptions x where x.consignment_id = c.id) as has_exception,
       cm.due_usd_cents - case when cm.due_usd_cents = 0 then 0 else c.amount_due_usd_cents end as errors_added_usd_cents,
       c.trust_at_time,
       coalesce(b.balance_usd_cents, 0) as customer_balance_usd_cents
from consignments c
join shipments s on s.id = c.shipment_id
join customers cu on cu.id = c.customer_id
join consignment_money cm on cm.consignment_id = c.id
left join consignment_last_stop ls on ls.consignment_id = c.id
left join customer_balances b on b.customer_id = c.customer_id;

