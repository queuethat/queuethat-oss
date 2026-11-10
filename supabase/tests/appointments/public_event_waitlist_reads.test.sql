-- 2B-A2/A4 (#277, #279): the anon reads behind the events tab and the offer page.
begin;
\ir ../helpers/_setup.psql
select plan(8);
select tests.create_world();

create temp table ctx as select slug from app.locations where id = tests.id('loc_a');
grant select on ctx to public;
select tests.as_anon();
select is((select count(*)::int from api.get_location_events((select slug from ctx))), 1,
  'the public event of a location is listed');
select is((select seats_taken from api.get_location_events((select slug from ctx))), 0, 'with seats taken against capacity');
select is((select count(*)::int from api.get_location_events('no-such-location')), 0, 'an unknown slug lists nothing');

select tests.as_postgres();
update app.events set public = false where id = tests.id('event_a');
select tests.as_anon();
select is((select count(*)::int from api.get_location_events((select slug from ctx))), 0, 'a private event is not listed');

select throws_ok($$ select api.guest_get_waitlist('no-such-token') $$, 'P0001', 'not_found', 'an unknown waitlist token is not_found');
select tests.as_postgres();
update app.slot_waitlist set token_hash = private.token_hash('tok-waitlist-a') where id = tests.id('waitlist_a');
select tests.as_anon();
select is((select status from api.guest_get_waitlist('tok-waitlist-a')), 'waiting', 'a waiting entry reads waiting');
select is((select offer_expires_at from api.guest_get_waitlist('tok-waitlist-a')), null, 'with no hold deadline');
select is((select to_jsonb(g) - 'status' - 'service_name' - 'location_name' - 'location_slug' - 'wanted_day' - 'slot_start' - 'slot_end' - 'offer_expires_at' - 'as_of'
           from api.guest_get_waitlist('tok-waitlist-a') g), '{}'::jsonb, 'and no field beyond status, names, times');

select * from finish();
rollback;
