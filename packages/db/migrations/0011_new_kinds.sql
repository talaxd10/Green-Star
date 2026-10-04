-- Two new names, added on their own: Postgres does not let a new enum value
-- be used in the transaction that adds it. 0012 uses them.
--
--   adjustment        an account that holds small differences nobody was
--                     paid or charged: what dinar rounding gave or took, and
--                     what the CEO wrote off as an error.
--   error_correction  the CEO's "Error" entry: a small amount taken off what
--                     one customer owes.

alter type account_kind add value 'adjustment';
alter type entry_kind add value 'error_correction';
