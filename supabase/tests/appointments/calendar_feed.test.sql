-- 2P-APT15 (#171): calendar feeds. The .ics rendering is covered by the Edge Function's Deno tests.
begin;
\ir ../helpers/_setup.psql
select plan(14);
select tests.create_world();

-- one appointment for staff, one for the manager
select private.set_actor('system', null);
insert into app.appointments (org_id, location_id, service_id, queue_id, staff_user_id, starts_at, ends_at, local_date, guest_name, guest_phone_e164, guest_email, source, idempotency_key)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'), tests.id('staff'), now() + interval '1 day', now() + interval '1 day 20 minutes', current_date + 1, 'Cora Smith', '+15551230009', 'cora@example.com', 'guest', gen_random_uuid()),
       (tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'), tests.id('manager'), now() + interval '2 days', now() + interval '2 days 20 minutes', current_date + 2, 'Dan Jones', null, null, 'guest', gen_random_uuid());

select tests.act_as('staff');
create temp table feed as select * from api.create_calendar_feed(false);
grant select on feed to public;
select is(length((select token from feed)), 43, 'the token is 43 url-safe characters');
select is((select count(*)::int from app.calendar_feeds where user_id = tests.id('staff')), 2, 'staff sees the fixture feed and the new one');
select throws_ok($$ select token_hash from app.calendar_feeds $$, '42501', null, 'nobody reads the hash back');
select tests.act_as('manager');
select is((select count(*)::int from app.calendar_feeds), 0, 'AC4: another member sees none of staff''s feeds');
select throws_ok($$ select api.revoke_calendar_feed((select feed_id from feed)) $$, 'P0001', 'not_found', 'a member cannot revoke someone else''s feed');
select throws_ok($$ select * from api.calendar_feed_events('x') $$, '42501', null, 'signed-in users cannot read feeds directly');

select tests.as_service();
select is((select count(*)::int from api.calendar_feed_events((select token from feed))), 1, 'the feed holds only staff''s own appointment');
select is((select guest_name from api.calendar_feed_events((select token from feed))), null, 'AC2: no guest name unless the feed opted in');
select is((select count(*)::int from api.calendar_feed_events((select token from feed)) e where e::text like '%555123%' or e::text like '%example.com%'), 0, 'AC1: no phone or email in the rows');

select tests.as_postgres();
update app.calendar_feeds set include_guest_names = true where id = (select feed_id from feed);
select tests.as_service();
select is((select guest_name from api.calendar_feed_events((select token from feed))), 'Cora', 'with the opt-in the first name only is shown');
select throws_ok($$ select * from api.calendar_feed_events('unknown-token') $$, 'P0001', 'not_found', 'an unknown token is not_found');

select tests.act_as('staff');
select lives_ok($$ select api.revoke_calendar_feed((select feed_id from feed)) $$, 'staff revokes the feed');
select tests.as_service();
select throws_ok($$ select * from api.calendar_feed_events((select token from feed)) $$, 'P0001', 'not_found', 'AC3: a revoked token is not_found');

-- a removed member's feed stops working
select tests.act_as('admin');
create temp table feed2 as select * from api.create_calendar_feed(false);
grant select on feed2 to public;
select tests.as_postgres();
delete from app.memberships where user_id = tests.id('admin');
select tests.as_service();
select throws_ok($$ select * from api.calendar_feed_events((select token from feed2)) $$, 'P0001', 'not_found', 'AC3: a member removed from the org gets not_found');

select * from finish();
rollback;
