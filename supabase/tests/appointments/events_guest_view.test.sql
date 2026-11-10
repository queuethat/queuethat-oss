-- 2B-A4 (#279): an event seat is not movable by the guest, and staff can read which seats belong to an event.
begin;
\ir ../helpers/_setup.psql
select plan(4);
select tests.create_world();

select tests.as_anon();
create temp table bk as
select token from api.book_event_seats(tests.id('event_a'), 'Pat', '+15550100001', 'pat@example.test', 2, gen_random_uuid());
grant select on bk to public;
select is((select can_reschedule from api.get_appointment((select token from bk))), false, 'a seat in an event cannot be moved by the guest');
select is((select can_cancel from api.get_appointment((select token from bk))), true, 'but can be cancelled');

select tests.act_as('staff');
select is((select seats from app.appointments where event_id = tests.id('event_a')), 2, 'staff read the seats a booking holds');
select tests.act_as('other_owner');
select is((select count(*)::int from app.appointments where event_id = tests.id('event_a')), 0, 'org B staff read no attendee of an org A event');

select * from finish();
rollback;
