-- Cash counted as one amount per currency. Tala, 28 October, of the
-- driver's cash count: "simplify this to just dollar and dinar".
--
-- A count was note by note: {"10000": 3, "5000": 1}. It can now also be one
-- amount, as a count of the smallest unit: {"1": 15000} is $150.00 counted
-- in total, {"1": 123250} is 123,250 IQD. Everything that adds a count up,
-- compares it and keeps it stays as it was; old counts keep their notes.

insert into cash_denominations (currency, value, label) values
  ('USD', 1, 'in total'),
  ('IQD', 1, 'in total');
