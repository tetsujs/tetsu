-- The orders of some statuses, each with its items, if it has any.
select o.id, o.status, i.line, i."Mixed Case" as mixed,
  count(*) over () as "total!"
from orders o
  left join order_items i on i.order_id = o.id
where o.status = any(:statuses) and (o.note = :note? or :note? is null)
order by o.id, i.line
