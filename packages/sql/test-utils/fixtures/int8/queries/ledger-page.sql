-- A page of the ledger after an id, with how many entries it holds in all.
select id, amount, count(*) over () as "entries!"
from ledger
where id > :after
order by id
limit :limit
