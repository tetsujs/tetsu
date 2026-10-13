create extension if not exists citext;

create extension if not exists hstore;

create type order_status as enum ('new', 'paid', 'shipped');

create domain positive as int4 check (value > 0);

create domain kind as text check (value in ('retail', 'bulk'));

create domain tag_list as text[] check (array_position(value, null) is null);

create domain note as text not null;

create domain moment as timestamptz;

create domain inner_kind as text check (value in ('a', 'b', 'c'));

create domain outer_kind as inner_kind not null check (value in ('a', 'b'));

create domain defaulted as int4 not null default 5;

create collation ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false);

create domain ci_kind as text collate ci check (value in ('retail', 'bulk'));

create type pair as (n int4, s text);

create type float_range as range (subtype = float8);

create schema billing;

create type billing.invoice_state as enum ('draft', 'sent', 'paid');
