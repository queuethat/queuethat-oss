-- 2B-Q10 (#235): per-queue join restrictions (on-site code and geofence).
begin;
\ir ../helpers/_setup.psql
select plan(20);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
select tests.new_id(k) from unnest(array['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9']) k;
-- Premises at 51.5 N, 0.1 W; radius 150 m. 0.001 degrees of latitude is about 111 m.
update app.locations set lat = 51.5, lng = -0.1, geofence_m = 150 where id = tests.id('loc_a');
update app.queues set join_restriction = 'geofence' where id = tests.id('queue_a');

create function tests.join_geo(p_key text, p_geo text, p_as text default 'service') returns text
language plpgsql as $$
begin
  if p_as = 'service' then perform tests.as_service(); else perform tests.as_anon(); end if;
  perform set_config('request.headers', jsonb_build_object('x-qm-geo', p_geo)::text, true);
  perform api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'G',
    p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => null,
    p_idempotency_key => tests.id(p_key));
  return 'ok';
exception when others then
  return sqlerrm;
end $$;
grant execute on function tests.join_geo(text, text, text) to anon, authenticated, service_role;

select is(tests.join_geo('k1', '51.5,-0.1,20'), 'ok', 'a guest at the premises joins');
select is(tests.join_geo('k2', '51.501,-0.1,20'), 'ok', 'about 111 m away is inside 150 m');
select is(tests.join_geo('k3', '51.518,-0.1,20'), 'onsite_required', 'AC3: 2 km away is refused');
select is(tests.join_geo('k4', '51.502,-0.1,80'), 'ok', 'a 222 m position with 80 m accuracy counts as 142 m');
select is(tests.join_geo('k5', '51.5025,-0.1,5000'), 'onsite_required', 'the accuracy allowance is capped at 100 m: 278 m is refused');
select is(tests.join_geo('k6', ''), 'onsite_required', 'an empty position is refused');
select is(tests.join_geo('k6', 'nope,-0.1,1'), 'onsite_required', 'a garbled position is refused');
select is(tests.join_geo('k6', 'NaN,NaN,1'), 'onsite_required', 'NaN is refused');
select is(tests.join_geo('k6', '51.5,-0.1,20', 'anon'), 'onsite_required', 'anyone but the service role cannot send a position');
select tests.as_postgres();
select is((select count(*)::int from app.visits where guest_name = 'G'), 3, 'refused joins created no visit');

-- AC4: staff are exempt.
select tests.act_as('staff');
select lives_ok(format($$ select api.staff_add_visit(%L, null, 'Walk-in', null, 1, %L) $$, tests.id('queue_a'), tests.id('k7')),
  'AC4: staff add a visit to a geofenced queue');

-- A geofence with no premises coordinates cannot be met.
select tests.as_postgres();
alter table app.locations disable trigger guard_geofence;
update app.locations set lat = null, lng = null where id = tests.id('loc_a');
select is(tests.join_geo('k8', '51.5,-0.1,20'), 'onsite_required', 'no coordinates on file: refused');
select tests.as_postgres();
alter table app.locations enable trigger guard_geofence;
update app.queues set join_restriction = 'none' where id = tests.id('queue_a');
select throws_ok(format($$ update app.locations set lat = 10 where id = %L $$, tests.id('loc_a')), '23514',
  null, 'a latitude without a longitude is rejected');

-- A geofence cannot be set without coordinates, nor the coordinates cleared under one.
select throws_ok(format($$ update app.queues set join_restriction = 'geofence' where id = %L $$, tests.id('queue_a')),
  'P0001', 'invalid_input', 'a geofence queue needs premises coordinates');
update app.locations set lat = 51.5, lng = -0.1 where id = tests.id('loc_a');
update app.queues set join_restriction = 'geofence' where id = tests.id('queue_a');
select throws_ok(format($$ update app.locations set lat = null, lng = null where id = %L $$, tests.id('loc_a')),
  'P0001', 'invalid_input', 'the coordinates cannot be cleared under a geofence queue');

-- On-site code restriction on the queue, with the location flag off.
update app.locations set onsite_code_required = false where id = tests.id('loc_a');
update app.queues set join_restriction = 'onsite_code' where id = tests.id('queue_a');
create function tests.join_code(p_key text, p_code text) returns text
language plpgsql as $$
begin
  perform api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'G',
    p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => null,
    p_idempotency_key => tests.id(p_key), p_onsite_code => p_code);
  return 'ok';
exception when others then
  return sqlerrm;
end $$;
grant execute on function tests.join_code(text, text) to anon;
select tests.as_anon();
select is(tests.join_code('k9', null), 'onsite_code_required', 'AC1: a queue set to onsite_code needs the code');
select is(tests.join_code('k9', '0000'), 'onsite_code_invalid', 'AC1: a wrong code is refused');
select tests.as_postgres();
create table tests.codes as select
  private.onsite_code(tests.id('loc_a'), now() - interval '10 minutes') as old,
  private.onsite_code(tests.id('loc_a'), now()) as current;
grant select on tests.codes to anon;
select tests.as_anon();
select is(tests.join_code('k9', (select old from tests.codes)), 'onsite_code_invalid', 'AC1: a ten-minute-old code is refused');
select is(tests.join_code('k9', (select current from tests.codes)), 'ok', 'AC2: the code on the display joins');

-- AC5: another tenant cannot read the code.
select tests.act_as('other_owner');
select throws_ok(format($$ select api.display_onsite_code(%L) $$, tests.id('loc_a')), 'P0001', 'not_found',
  'AC5: another tenant is denied the code');

select * from finish();
rollback;
