-- An order, by its id: its columns as the file of types reads them.
select id, number, status, shipping, kind, channel, priority, region, tags,
  labels, notes, scores, coupons, history, moments, amount, total, note,
  email, payload, placed_on, placed_at, receipt, attributes
from orders
where id = :id
