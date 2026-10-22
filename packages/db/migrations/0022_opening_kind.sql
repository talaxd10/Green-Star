-- A new kind of entry, added on its own: Postgres does not let a new enum
-- value be used in the transaction that adds it. 0023 uses it.
--
--   opening_balance  what stood on the day the system started: a customer's
--                    debt or credit, the cash in the vault, what is owed to
--                    the China office. Typed in by the CEO.

alter type entry_kind add value 'opening_balance';
