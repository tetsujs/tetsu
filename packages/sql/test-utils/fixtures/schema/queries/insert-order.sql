-- Inserts an order.
insert into orders (
  kind, channel, quantity, amount, note, outer_kind, required_attributes,
  tags, payload, placed_at
)
values (
  :kind, :channel, :quantity, :amount, :note, 'a', :attributes, :tags,
  :payload, :placedAt
)
returning id, placed_at
