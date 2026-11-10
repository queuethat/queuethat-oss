-- 2B-J4 (#242): the join page reads a queue's join-later window from api.get_location_wait.
begin;
\ir ../helpers/_setup.psql
select plan(6);
select tests.create_world();
select tests.as_postgres();
-- The slots below sit minutes to hours ahead of now and must stay on the location's service day
-- (it rolls over at 04:00 local), so put the location's clock at noon whatever time the test runs.
update app.locations set tz = case
  when extract(hour from now() at time zone 'UTC') = 12 then 'Etc/UTC'
  else 'Etc/GMT' || case when extract(hour from now() at time zone 'UTC') < 12 then '-' else '+' end
       || abs(12 - extract(hour from now() at time zone 'UTC'))::int
  end
 where id = tests.id('loc_a');
create temp table slug as select slug from app.locations where id = tests.id('loc_a');
grant select on slug to anon;

select tests.as_anon();
select is((select join_later_max_hours from api.get_location_wait((select slug from slug)) where queue_id = tests.id('queue_a')),
  null, 'a queue that does not offer joining later says nothing');
select tests.as_postgres();
update app.queues set join_later_enabled = true, join_later_max_hours = 6 where id = tests.id('queue_a');
select tests.as_anon();
select is((select join_later_max_hours from api.get_location_wait((select slug from slug)) where queue_id = tests.id('queue_a')),
  6, 'an enabled queue says how many hours ahead');
select tests.as_postgres();
update app.queues set join_later_enabled = false where id = tests.id('queue_a');
select tests.as_anon();
select is((select join_later_max_hours from api.get_location_wait((select slug from slug)) where queue_id = tests.id('queue_a')),
  null, 'switching it off hides it again');

-- a guest who joined for later may leave before their time; an appointment may not
select tests.as_postgres();
update app.queues set join_later_enabled = true, join_later_max_hours = 6 where id = tests.id('queue_a');
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
select tests.as_service();
create temp table later as
  select (api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'Later',
    p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => 'en',
    p_idempotency_key => gen_random_uuid(), p_device_key => 'later-device-key-0123456789abcdef',
    p_arrive_after => now() + interval '30 minutes')).token as token;
select tests.as_postgres();
grant select on later to anon;
select tests.as_anon();
select is((api.get_visit_status((select token from later))).guest_actions, array['leave']::api.guest_action[],
  'a visit joined for later offers leave');
select is((api.guest_act((select token from later), 'leave', gen_random_uuid())).status, 'cancelled'::api.visit_state,
  'and leaving cancels it');
select tests.as_postgres();
select is((select status::text from app.visits where guest_name = 'Later'), 'cancelled', 'the visit is cancelled');
select * from finish();
rollback;
