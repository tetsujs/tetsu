create table ledger (
  id int8 generated always as identity primary key,
  amount int8 not null,
  refs int8[] not null default '{}' check (array_position(refs, null) is null),
  note text
);
