-- #507 (20261025094000_push_one_visit.sql): one browser, one visit. Registering a push endpoint
-- takes it off every other visit, in any org, so a shared phone stops getting the previous guest's
-- alerts.
begin;
\ir ../helpers/_setup.psql
select plan(11);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Other org', 'B');
create table tests.tokens (name text primary key, token text);
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.tokens to anon;

create function tests.register(p_name text, p_endpoint text) returns void language sql as $$
  select api.guest_register_push((select token from tests.tokens where name = p_name), p_endpoint,
                                 'B' || repeat('x', 86), repeat('a', 22))
$$;
/** Endpoints registered on a guest's visit. */
create function tests.endpoints(p_name text) returns text[] language sql security definer as $$
  select coalesce(array_agg(s.endpoint order by s.endpoint), '{}') from app.push_subscriptions s
  where s.visit_id = (select v.id from app.visits v
                      where v.guest_token_hash = private.token_hash((select token from tests.tokens where name = p_name)))
$$;
grant execute on all functions in schema tests to anon;

select tests.as_anon();
insert into tests.tokens
select 'ann', (api.join_queue(tests.id('queue_a'), null, 'Ann', null, null, 1, null, gen_random_uuid())).token;
insert into tests.tokens
select 'bob', (api.join_queue(tests.id('queue_a'), null, 'Bob', null, null, 1, null, gen_random_uuid())).token;
insert into tests.tokens
select 'cara', (api.join_queue(tests.id('queue_b'), null, 'Cara', null, null, 1, null, gen_random_uuid())).token;

-- The shared phone (E) and Ann's own laptop (F).
select tests.register('ann', 'https://fcm.googleapis.com/fcm/send/shared-phone');
select tests.register('ann', 'https://updates.push.services.mozilla.com/wpush/v2/ann-laptop');

select tests.register('bob', 'https://fcm.googleapis.com/fcm/send/shared-phone');
select is(tests.endpoints('bob'), array['https://fcm.googleapis.com/fcm/send/shared-phone'],
  'the next guest on the shared phone gets its alerts');
select is(tests.endpoints('ann'), array['https://updates.push.services.mozilla.com/wpush/v2/ann-laptop'],
  'the previous guest''s visit no longer has that endpoint, but keeps the guest''s other browser');

select tests.register('bob', 'https://fcm.googleapis.com/fcm/send/shared-phone');
select is(tests.endpoints('bob'), array['https://fcm.googleapis.com/fcm/send/shared-phone'],
  'registering again on the same visit changes nothing');

-- Cross-tenant: the same phone joins another org's queue.
select lives_ok($$ select tests.register('cara', 'https://fcm.googleapis.com/fcm/send/shared-phone') $$,
  'registering an endpoint another org''s visit holds succeeds like any other (nothing to tell apart)');
select is(tests.endpoints('cara'), array['https://fcm.googleapis.com/fcm/send/shared-phone'],
  'the org B visit gets the endpoint');
select is(tests.endpoints('bob'), '{}'::text[], 'and the org A visit loses it');

select tests.as_postgres();
select is((select count(*)::int from app.push_subscriptions
           where endpoint = 'https://fcm.googleapis.com/fcm/send/shared-phone'), 1,
  'one browser, one visit: the endpoint is registered once in the whole database');
select is((select org_id from app.push_subscriptions
           where endpoint = 'https://fcm.googleapis.com/fcm/send/shared-phone'), tests.id('org_b'),
  'the remaining row belongs to the new visit''s org, not copied from org A');

-- Security review of #510: knowing an endpoint is not enough to take it.
select tests.as_anon();
insert into tests.tokens
select 'mallory', (api.join_queue(tests.id('queue_a'), null, 'Mallory', null, null, 1, null, gen_random_uuid())).token;
select api.guest_register_push((select token from tests.tokens where name = 'mallory'),
  'https://fcm.googleapis.com/fcm/send/shared-phone', 'B' || repeat('y', 86), repeat('b', 22));
select is(tests.endpoints('cara'), array['https://fcm.googleapis.com/fcm/send/shared-phone'],
  'registering a known endpoint with other keys leaves the other org''s subscription alone');

select tests.act_as('owner');
select throws_ok($$ select endpoint from app.push_subscriptions $$, '42501', null,
  'org admins cannot read subscription endpoints');
select throws_ok($$ select p256dh, auth from app.push_subscriptions $$, '42501', null,
  '... or keys');

select * from finish();
rollback;
