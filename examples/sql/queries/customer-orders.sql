-- A customer's orders, newest first, with the shipment of each that has
-- one.
select o.id, o.status, o.total, s.carrier, s.shipped_at
from orders o
  left join shipments s on s.order_id = o.id
where o.customer_id = :customerId
order by o.placed_at desc
