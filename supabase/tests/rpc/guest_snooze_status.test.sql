-- 2A-GST3 (#124): what the status page needs to offer on-my-way and need-more-time, and what the
-- console needs to show "On the way": api.visit_status grace_until, warn_at, snoozes_left and
-- on_the_way, and app.staff_visits.on_the_way.
begin;
\ir ../helpers/_setup.psql
select plan(16);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix, grace_minutes, no_show_warning_seconds,
                        max_snoozes) values
  (tests.new_id('queue_g'), tests.id('org_a'), tests.id('loc_a'), 'Grace', 'G', 5, 60, 1),
  (tests.new_id('queue_n'), tests.id('org_a'), tests.id('loc_a'), 'NoSnooze', 'N', 5, 60, 0);

create table tests.tokens (name text primary key, token text, visit_id uuid);
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.tokens to anon;
select set_config('request.headers', '{"x-real-ip": "198.51.100.89"}', true);

select tests.as_anon();
insert into tests.tokens (name, token)
  select n, (api.join_queue(tests.id('queue_g'), null, initcap(n), null, null, 1, 'en', gen_random_uuid())).token
  from unnest(array['gil', 'hal', 'ivy']) n;
insert into tests.tokens (name, token)
  select 'nina', (api.join_queue(tests.id('queue_n'), null, 'Nina', null, null, 1, 'en', gen_random_uuid())).token;
select tests.as_postgres();
update tests.tokens t set visit_id = v.id from app.visits v where v.guest_token_hash = private.token_hash(t.token);

create function tests.status(p_name text) returns api.visit_status
language sql as $$ select api.get_visit_status((select token from tests.tokens where name = p_name)) $$;
create function tests.act(p_name text, p_action api.guest_action, p_key uuid default gen_random_uuid())
returns api.visit_status
language sql as $$ select api.guest_act((select token from tests.tokens where name = p_name), p_action, p_key) $$;
grant execute on all functions in schema tests to anon;

-- Waiting: the remaining snoozes, no deadline, nobody on the way
select tests.as_anon();
select is((tests.status('hal')).snoozes_left, 1, 'a waiting guest sees how many snoozes are left');
select is((tests.status('hal')).grace_until, null, 'and no arrival deadline');
select is((tests.status('hal')).on_the_way, false, 'and is not on the way');
select ok(not 'need_more_time' = any ((tests.status('nina')).guest_actions),
  'snoozing turned off (max_snoozes 0): need_more_time is not offered');
select is((tests.status('nina')).snoozes_left, 0, 'and none are left');

-- Called: the deadline and the moment to warn
select tests.act_as('staff');
select (api.call_next(tests.id('queue_g'), tests.id('counter_a'), gen_random_uuid())).id;
select tests.as_anon();
select isnt((tests.status('gil')).grace_until, null, 'a called guest sees the arrival deadline');
select is((tests.status('gil')).grace_until - (tests.status('gil')).warn_at, interval '60 seconds',
  'warn_at is no_show_warning_seconds before it');
select is((tests.status('hal')).grace_until, null, 'a guest still waiting has no deadline');

-- On my way
select tests.as_postgres();
create table tests.g0 as select grace_until from app.visits where id = (select visit_id from tests.tokens where name = 'gil');
grant select on tests.g0 to anon;
select is((select on_the_way from app.staff_visits where id = (select visit_id from tests.tokens where name = 'gil')),
  false, 'staff see no badge before the guest taps');
select tests.as_anon();
select is((tests.act('gil', 'on_my_way')).on_the_way, true, 'on_my_way marks the visit on the way');
select tests.as_postgres();
select is((select grace_until - (select grace_until from tests.g0) from app.visits
           where id = (select visit_id from tests.tokens where name = 'gil')), interval '5 minutes',
  'the deadline the guest sees moved out');
select is((select on_the_way from app.staff_visits where id = (select visit_id from tests.tokens where name = 'gil')),
  true, 'staff see On the way');

-- Needing time puts the guest back in line: no longer on the way, one snooze used
select tests.as_anon();
select is((tests.act('gil', 'need_more_time')).on_the_way, false, 'asking for more time clears on the way');
select is((tests.status('gil')).snoozes_left, 0, 'and uses the only snooze');

-- Cross-tenant: another org's staff do not see this org's visits through the view
select tests.act_as('other_owner');
select is_empty($$ select on_the_way from app.staff_visits where org_id = tests.id('org_a') $$,
  'another org''s owner reads no on_the_way flags of org A');
select tests.as_postgres();
select is((select count(*)::int from app.visit_events where visit_id = (select visit_id from tests.tokens where name = 'gil')
           and type = 'on_my_way'), 1, 'one on_my_way event, nothing new written by reading');

select * from finish();
rollback;
