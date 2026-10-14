create table customers (
  id int8 generated always as identity primary key,
  email text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);
