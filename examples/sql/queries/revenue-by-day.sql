-- The revenue of paid and shipped orders, by day, since a time.
select date_trunc('day', placed_at) as "day!", sum(total) as "revenue!",
  count(*) as "orders!"
from orders
where status in ('paid', 'shipped') and placed_at >= :since
group by 1
order by 1
