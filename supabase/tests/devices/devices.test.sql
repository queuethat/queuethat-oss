-- D1 (#48): pairing codes, redemption, registration, heartbeat and revocation.
begin;
\ir ../helpers/_setup.psql
select plan(50);

select tests.create_world();

/** The error a statement raises as 'SQLSTATE message', or 'ok'. Runs as the current role. */
create function tests.error_of(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function tests.error_of(text) to authenticated, service_role;

create table tests.codes (name text primary key, code text not null);
grant all on tests.codes to authenticated, service_role;

-- ------------------------------------------------------------------ create_pairing_code
select tests.act_as('admin');
insert into tests.codes
select 'tv', (api.create_pairing_code(tests.id('loc_a'), 'display', 'Lobby TV')).code;
select matches((select code from tests.codes where name = 'tv'), '^[0-9]{6}$',
  'an admin gets a 6-digit code');
select tests.as_postgres();
select ok((select expires_at between now() + interval '9 minutes 59 seconds' and now() + interval '10 minutes'
           from app.device_pairing_codes
           where code_hash = extensions.digest((select code from tests.codes where name = 'tv'), 'sha256')),
  'the code expires in 10 minutes');
select is((select count(*)::int from app.device_pairing_codes
           where code_hash = extensions.digest((select code from tests.codes where name = 'tv'), 'sha256')
             and name = 'Lobby TV' and kind = 'display' and used_at is null),
  1, 'only the code''s hash is stored, with kind and name');

select tests.act_as('owner');
select lives_ok($$ select api.create_pairing_code(tests.id('loc_a'), 'kiosk', 'Door') $$,
  'an owner can create a code');
select tests.act_as('manager');
select throws_ok($$ select api.create_pairing_code(tests.id('loc_a'), 'kiosk', 'x') $$,
  'P0001', 'not_found', 'a manager cannot create a code');
select tests.act_as('other_owner');
select throws_ok($$ select api.create_pairing_code(tests.id('loc_a'), 'kiosk', 'x') $$,
  'P0001', 'not_found', 'another org''s owner cannot create a code (no existence leak)');
select tests.act_as('admin');
select throws_ok($$ select api.create_pairing_code(tests.id('loc_a'), 'kiosk', repeat('x', 81)) $$,
  'P0001', 'invalid_input', 'a name over 80 characters is rejected');

-- The fixture code, the tv code and the door code are live; seven more reach the cap of 10.
select lives_ok($$ select api.create_pairing_code(tests.id('loc_a'), 'kiosk', 'n')
                   from generate_series(1, 7) $$, 'seven more codes fit under the cap');
select throws_ok($$ select api.create_pairing_code(tests.id('loc_a'), 'kiosk', 'n') $$,
  'P0001', 'rate_limited', 'an org cannot hold more than 10 live codes');

-- ------------------------------------------------------------------ redeem_pairing_code
select tests.act_as('admin');
select throws_ok($$ select api.redeem_pairing_code('000000', 'x') $$,
  '42501', null, 'signed-in users cannot redeem codes directly');
select tests.as_anon();
select throws_ok($$ select api.redeem_pairing_code('000000', 'x') $$,
  '42501', null, 'anon cannot redeem codes directly');

select tests.as_postgres();
create table tests.claim of api.device_claim;
grant all on tests.claim to authenticated, service_role;
select tests.as_service();
insert into tests.claim
select * from api.redeem_pairing_code((select code from tests.codes where name = 'tv'), 'client-1');
select results_eq($$ select org_id, location_id, kind::text, name from tests.claim $$,
  $$ values (tests.id('org_a'), tests.id('loc_a'), 'display', 'Lobby TV') $$,
  'redeeming returns the claims for app_metadata');
select isnt((select device_id from tests.claim), null, 'the claim carries the future device id');

-- AC1: used, expired and unknown codes fail the same way.
select is((select device_id from api.redeem_pairing_code((select code from tests.codes where name = 'tv'), 'client-1')),
  null, 'a used code returns null');
select tests.as_postgres();
delete from app.device_pairing_codes where name = 'n'; -- the cap is full; make room
select tests.as_user(tests.id('admin'));
insert into tests.codes
select 'expired', (api.create_pairing_code(tests.id('loc_a'), 'display', '')).code;
select tests.as_postgres();
update app.device_pairing_codes set expires_at = now() - interval '1 second'
where code_hash = extensions.digest((select code from tests.codes where name = 'expired'), 'sha256');
select tests.as_service();
select is((select device_id from api.redeem_pairing_code((select code from tests.codes where name = 'expired'), 'client-1')),
  null, 'an expired code returns null');
select is((select row(r.*)::text from api.redeem_pairing_code('not-a-code', 'client-1') r),
  (select row(r.*)::text from api.redeem_pairing_code((select code from tests.codes where name = 'tv'), 'client-1') r),
  'unknown and used codes give an identical response');

-- That was 4 failures from client-1; the 5th is allowed, the 6th is rate limited.
select is((select device_id from api.redeem_pairing_code('nope', 'client-1')), null, 'fifth failure');
select throws_ok($$ select api.redeem_pairing_code('nope', 'client-1') $$,
  'P0001', 'rate_limited', 'a client is limited after 5 failures in 10 minutes');
select is((select device_id from api.redeem_pairing_code('nope', 'client-2')), null,
  'another client is not limited');
select tests.as_postgres();
select is((select count(*)::int from private.pairing_failures
           where client_hash = extensions.digest('client-1', 'sha256')), 5,
  'failures are kept by hashed client key');
insert into private.pairing_failures (client_hash)
select extensions.digest('crowd-' || i, 'sha256') from generate_series(1, 100) i;
select tests.as_service();
select throws_ok($$ select api.redeem_pairing_code('nope', 'client-3') $$,
  'P0001', 'rate_limited', '100 failures from everyone in 10 minutes stop all redemption');
select tests.as_postgres();
update private.pairing_failures set at = now() - interval '11 minutes';
select tests.as_service();
select is((select device_id from api.redeem_pairing_code('nope', 'client-1')), null,
  'failures older than 10 minutes no longer count');

-- ------------------------------------------------------------------ register_device
select tests.as_postgres();
select tests.create_user('tv_user', jsonb_build_object('kind', 'display'));
select tests.create_user('intruder');
select tests.as_service();
select lives_ok(format('select api.register_device(%L, %L)', (select device_id from tests.claim), tests.id('tv_user')),
  'the function registers the device for its new auth user');
select lives_ok(format('select api.register_device(%L, %L)', (select device_id from tests.claim), tests.id('tv_user')),
  'registering again with the same user changes nothing');
select throws_ok(format('select api.register_device(%L, %L)', (select device_id from tests.claim), tests.id('intruder')),
  'P0001', 'not_found', 'a registered device cannot be rebound to another user');
select throws_ok(format('select api.register_device(%L, %L)', gen_random_uuid(), tests.id('intruder')),
  'P0001', 'not_found', 'a device id no code was redeemed for is rejected');
select tests.as_postgres();
select results_eq(
  format('select org_id, location_id, kind::text, name from app.devices where id = %L', (select device_id from tests.claim)),
  $$ values (tests.id('org_a'), tests.id('loc_a'), 'display', 'Lobby TV') $$,
  'the device row carries the code''s location, kind and name');
select tests.as_user(tests.id('tv_user'));
select ok(private.is_device(tests.id('org_a'), tests.id('loc_a')), 'the new user is a device of the location');

-- ------------------------------------------------------------------ device_heartbeat
select lives_ok($$ select api.device_heartbeat('1.2.3') $$, 'a device can send a heartbeat');
select tests.as_postgres();
select results_eq(
  format('select app_version, last_seen_at is not null from app.devices where id = %L', (select device_id from tests.claim)),
  $$ values ('1.2.3', true) $$, 'the heartbeat records version and time');
select is((select count(*)::int from app.audit_log
           where table_name = 'devices' and action = 'UPDATE' and row_id = (select device_id from tests.claim)::text),
  0, 'heartbeats are not audited');
select tests.as_user(tests.id('tv_user'));
select lives_ok($$ select api.device_heartbeat('1.2.3', 2) $$, 'a heartbeat can carry live-update drops');
select lives_ok($$ select api.device_heartbeat('1.2.3', 100000) $$, 'a huge count is clamped');
select lives_ok($$ select api.device_heartbeat('1.2.3', -50) $$, 'a negative count is ignored');
select tests.as_postgres();
select results_eq(
  format('select realtime_drops, last_drop_at is not null from app.devices where id = %L', (select device_id from tests.claim)),
  $$ values (102, true) $$, 'drops add up, clamped to 100 per heartbeat');
select is((select count(*)::int from app.audit_log
           where table_name = 'devices' and action = 'UPDATE' and row_id = (select device_id from tests.claim)::text),
  0, 'drops are not audited either');
select is((select realtime_drops from app.devices where id = tests.id('kiosk_device')), 0,
  'another screen''s drops are untouched');
select tests.act_as('staff');
select throws_ok($$ select api.device_heartbeat('1') $$, 'P0001', 'not_found',
  'a person is not a device');

-- ------------------------------------------------------------------ AC3: devices cannot write
select tests.act_as('display');
select is(tests.error_of($$ select api.create_organization('Mine', 'Here', 'UTC') $$),
  '42501 permission_denied', 'a display cannot create an organization');
select is(tests.error_of($$ select api.create_pairing_code(tests.id('loc_a'), 'display', 'x') $$),
  'P0001 not_found', 'a display cannot create pairing codes');
select is(tests.error_of(format('select api.revoke_device(%L)', tests.id('kiosk_device'))),
  'P0001 not_found', 'a display cannot revoke devices');

select ok(tests.error_of($$ select api.call_next(tests.id('queue_a'), tests.id('counter_a'), gen_random_uuid()) $$)
          in ('P0001 not_found', '42501 permission_denied'), 'a display cannot call next');
select ok(tests.error_of($$ select api.transition_visit(tests.id('visit_a'), 'call', 1, gen_random_uuid()) $$)
          in ('P0001 not_found', '42501 permission_denied'), 'a display cannot transition a visit');
select ok(tests.error_of($$ select api.undo_event(1, gen_random_uuid()) $$)
          in ('P0001 not_found', '42501 permission_denied'), 'a display cannot undo');
select ok(tests.error_of($$ select api.staff_add_visit(tests.id('queue_a'), null, 'x', null, 1, gen_random_uuid()) $$)
          in ('P0001 not_found', '42501 permission_denied'), 'a display cannot add a walk-in');
select ok(tests.error_of($$ select api.set_queue_state(tests.id('queue_a'), 'closed') $$)
          in ('P0001 not_found', '42501 permission_denied'), 'a display cannot close a queue');

-- ------------------------------------------------------------------ revoke_device
select tests.as_postgres();
insert into auth.sessions (id, user_id, created_at) values (gen_random_uuid(), tests.id('tv_user'), now());
select tests.act_as('staff');
select throws_ok(format('select api.revoke_device(%L)', (select device_id from tests.claim)),
  'P0001', 'not_found', 'staff cannot revoke a device');
select tests.act_as('admin');
select lives_ok(format('select api.revoke_device(%L)', (select device_id from tests.claim)),
  'an admin revokes the device');
select tests.as_postgres();
select ok((select banned_until > now() + interval '99 years' from auth.users where id = tests.id('tv_user'))
          and not exists (select 1 from auth.sessions where user_id = tests.id('tv_user')),
  'AC2: revocation bans the auth user and deletes its sessions, so refresh fails');
select tests.as_user(tests.id('tv_user'));
select ok(not private.is_device(tests.id('org_a'), tests.id('loc_a')),
  'AC2: a revoked device loses access on its next request, before its token expires');

select * from finish();
rollback;
