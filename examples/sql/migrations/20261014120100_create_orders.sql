create type order_status as enum ('new', 'paid', 'shipped');

create table orders (
  id int8 generated always as identity primary key,
  customer_id int8 not null references customers (id),
  status order_status not null default 'new',
  total numeric(12, 2) not null check (total >= 0),
  tags text[] not null default '{}',
  note text,
  placed_at timestamptz not null default now()
);

create index orders_customer_id_idx on orders (customer_id);

create table shipments (
  order_id int8 primary key references orders (id),
  carrier text not null,
  shipped_at timestamptz not null default now()
);
