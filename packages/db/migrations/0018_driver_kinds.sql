-- New kinds for the driver's own account. An enum value can only be used
-- once the migration that adds it is committed, so they come first, alone.
--
--   driver_float     the money the office gave a driver to spend on the road,
--                    one account per driver per currency
--   driver_advance   the office gives him money when he leaves
--   driver_expense   a receipt he brings back: fuel, car parts, workers, a
--                    transport company between cities
--   driver_return    he gives back what he did not spend

alter type account_kind add value 'driver_float';
alter type entry_kind add value 'driver_advance';
alter type entry_kind add value 'driver_expense';
alter type entry_kind add value 'driver_return';
