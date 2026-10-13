select i.id as invoice, i.state, o.id as "order"
from billing.invoices i
  full join orders o on o.id = i.order_id
