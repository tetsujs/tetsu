update orders set status = 'shipped' where id = :id and status = 'paid'
