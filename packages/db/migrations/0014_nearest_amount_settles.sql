-- When dinars come to both what is owed on the goods and everything the
-- customer owes (the two are less than a rounding step apart), the nearer
-- one is what they settle. Before this the goods always won, so a customer
-- who owed $62.00 on today's goods and 30 cents from before, and handed over
-- 90,300 dinars ($62.28), was credited $62.00 and still owed the 30 cents.
-- Now he is credited $62.30 and owes nothing.
--
-- The ledger's own check is unchanged: a rounded payment settles the
-- consignment it is for, or everything he owes. This only decides which.

create or replace function gs_dinar_credit(p_dinars bigint, p_iqd_per_100_usd integer, p_owed_first bigint, p_owed_all bigint) returns bigint
language sql stable as $$
  select case
           when gs_dinars_settle(p_dinars, p_iqd_per_100_usd, p_owed_first)
            and gs_dinars_settle(p_dinars, p_iqd_per_100_usd, p_owed_all)
           then case
                  when abs(p_dinars - gs_usd_cents_to_iqd(p_owed_first, p_iqd_per_100_usd))
                     < abs(p_dinars - gs_usd_cents_to_iqd(p_owed_all, p_iqd_per_100_usd))
                  then p_owed_first
                  else p_owed_all          -- as near, or nearer: everything is settled
                end
           when gs_dinars_settle(p_dinars, p_iqd_per_100_usd, p_owed_first) then p_owed_first
           when gs_dinars_settle(p_dinars, p_iqd_per_100_usd, p_owed_all) then p_owed_all
           else gs_iqd_to_usd_cents(p_dinars, p_iqd_per_100_usd)
         end;
$$;
