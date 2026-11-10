-- N4 (#70): api.guest_register_push, and gone push results deleting the subscription.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Other org', 'B');
create table tests.tokens (name text primary key, token text);
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.tokens to anon;

-- Keys shaped like a browser's PushSubscription.toJSON(): 87 and 22 base64url characters.
create function tests.p256dh() returns text language sql as $$ select 'B' || repeat('x', 86) $$;
create function tests.auth() returns text language sql as $$ select repeat('a', 22) $$;
create function tests.register(p_token text, p_endpoint text) returns void language sql as $$
  select api.guest_register_push(p_token, p_endpoint, tests.p256dh(), tests.auth())
$$;
create function tests.subs(p_token text) returns bigint language sql security definer as $$
  select count(*) from app.push_subscriptions s
  where s.visit_id = (select id from app.visits where guest_token_hash = private.token_hash(p_token))
$$;
grant execute on all functions in schema tests to anon;

select tests.as_anon();
insert into tests.tokens select 'ann', (api.join_queue(tests.id('queue_a'), null, 'Ann', null, null, 1, null, gen_random_uuid())).token;
select tests.as_postgres();

select tests.as_anon();
select lives_ok($$ select tests.register((select token from tests.tokens where name = 'ann'),
                                         'https://fcm.googleapis.com/fcm/send/abc:def') $$,
  'anon registers an FCM subscription with the visit token');
select lives_ok($$ select tests.register((select token from tests.tokens where name = 'ann'),
                                         'https://fcm.googleapis.com/fcm/send/abc:def') $$,
  'registering the same endpoint again is fine');
select is(tests.subs((select token from tests.tokens where name = 'ann')), 1::bigint,
  '... and changes nothing');
select lives_ok($$ select api.guest_register_push((select token from tests.tokens where name = 'ann'),
  'https://web.push.apple.com/QH3k', tests.p256dh() || '=', tests.auth() || '==') $$,
  'Apple endpoints and padded keys are accepted');

select throws_ok($$ select tests.register('not-a-token', 'https://fcm.googleapis.com/fcm/send/x') $$,
  'P0001', 'not_found', 'an unknown token gets not_found');
select throws_ok($$ select tests.register((select token from tests.tokens where name = 'ann'),
                                          'http://fcm.googleapis.com/fcm/send/x') $$,
  'P0001', 'invalid_input', 'a plain http endpoint is rejected');
select throws_ok($$ select tests.register((select token from tests.tokens where name = 'ann'),
                                          'https://evil.example/fcm.googleapis.com/x') $$,
  'P0001', 'invalid_input', 'an endpoint on an unknown host is rejected (no request relay)');
select throws_ok($$ select tests.register((select token from tests.tokens where name = 'ann'),
                                          'https://fcm.googleapis.com.evil.example/x') $$,
  'P0001', 'invalid_input', 'a look-alike host is rejected');
select throws_ok($$ select api.guest_register_push((select token from tests.tokens where name = 'ann'),
  'https://fcm.googleapis.com/fcm/send/y', 'short', tests.auth()) $$,
  'P0001', 'invalid_input', 'a malformed key is rejected');
select throws_ok($$ select * from app.push_subscriptions $$, '42501', null,
  'anon still cannot read subscriptions');

select tests.as_anon();
do $$
begin
  for i in 1..6 loop
    perform tests.register((select token from tests.tokens where name = 'ann'),
                           'https://updates.push.services.mozilla.com/wpush/v2/' || i);
  end loop;
end $$;
select is(tests.subs((select token from tests.tokens where name = 'ann')), 5::bigint,
  'a visit keeps only its five newest subscriptions');
select tests.as_postgres();

-- AC1: a gone (410) result for a push row deletes its subscription; other rows keep theirs.
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
values (tests.new_id('n_push'), tests.id('org_a'), tests.id('visit_a'), 'push', tests.id('push_a'), 'called', 1, 'n_push');
update app.notifications set next_attempt_at = now() - interval '1 minute';
select tests.as_service();
select count(*) from api.claim_outbox(50, 60);
select api.report_outbox_result(tests.id('n_push'), '{"status": "gone", "error_code": "http_410", "provider": "vapid"}');
select tests.as_postgres();
select is((select count(*) from app.push_subscriptions where id = tests.id('push_a')), 0::bigint,
  'AC1: a 410 from the push service removes the subscription');
select is((select count(*) from app.push_subscriptions), 5::bigint,
  'other subscriptions stay');

select * from finish();
rollback;
