-- 2B-D1 (#258): counter-scoped display devices and api.counter_display_snapshot.
begin;
\ir ../helpers/_setup.psql
select plan(17);
select tests.create_world();

-- A second display of org A, for Chair 2, and a visit called at Chair 1.
do $$
declare uid uuid := tests.create_user('display2', jsonb_build_object('kind', 'display'));
begin
  insert into app.devices (id, org_id, location_id, kind, name, auth_user_id)
  values (tests.new_id('display2_device'), tests.id('org_a'), tests.id('loc_a'), 'display', 'd2', uid);
  insert into tests.actors values ('display2', 'authenticated', jsonb_build_object(
    'sub', uid, 'role', 'authenticated', 'aud', 'authenticated',
    'app_metadata', jsonb_build_object('kind', 'display', 'org_id', tests.id('org_a'), 'location_id', tests.id('loc_a'))));
end $$;
select tests.new_visit('v1', 'queue_a', 'Dana Lee');

create function tests.error_of(p_sql text) returns text
language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function tests.error_of(text) to authenticated;

-- ------------------------------------------------------------------ binding
select tests.act_as('display');
select is(tests.error_of($$ select api.counter_display_snapshot() $$), 'P0001 not_found',
  'a display with no counter reads nothing');
select is(tests.error_of(format('select api.set_device_counter(%L, %L)', tests.id('display_device'), tests.id('counter_a'))),
  'P0001 not_found', 'a device cannot bind itself');

select tests.act_as('admin');
select is(tests.error_of(format('select api.set_device_counter(%L, %L)', tests.id('kiosk_device'), tests.id('counter_a'))),
  'P0001 invalid_input', 'a kiosk cannot be bound to a counter');
select is(tests.error_of(format('select api.set_device_counter(%L, %L)', tests.id('display_device'), gen_random_uuid())),
  'P0001 not_found', 'an unknown counter is rejected');
select lives_ok(format('select api.set_device_counter(%L, %L)', tests.id('display_device'), tests.id('counter_a')),
  'an admin binds a display to Chair 1');
select lives_ok(format('select api.set_device_counter(%L, %L)', tests.id('display_device'), tests.id('counter_a')),
  'binding the same counter again is a no-op');
select lives_ok(format('select api.set_device_counter(%L, %L)', tests.id('display2_device'), tests.id('counter_pair')),
  'an admin binds the second display to Chair 2');
select tests.act_as('other_owner');
select is(tests.error_of(format('select api.set_device_counter(%L, %L)', tests.id('display_device'), null)),
  'P0001 not_found', 'another org''s owner cannot unbind a device');
select tests.act_as('manager');
select is(tests.error_of(format('select api.set_device_counter(%L, %L)', tests.id('display_device'), null)),
  'P0001 not_found', 'a manager cannot change a binding');

-- ------------------------------------------------------------------ snapshot
select tests.act_as('display');
select is((api.counter_display_snapshot()).status, 'idle', 'nothing called: idle');
select is((api.counter_display_snapshot()).counter_label, 'Chair 1', 'the counter label comes back');

select tests.as_postgres();
select private.set_actor('staff', tests.id('staff'), 'call');
update app.visits set status = 'called', called_at = now(), counter_id = tests.id('counter_a')
where id = tests.id('v1');

create table tests.snap (status text, ticket text);
grant all on tests.snap to authenticated;
select tests.act_as('display');
insert into tests.snap select s.status, s.ticket from api.counter_display_snapshot() s;
select tests.as_postgres();
select results_eq($$ select status, ticket from tests.snap $$,
  $$ select 'serving', display_ticket from app.visits where id = tests.id('v1') $$,
  'Chair 1 shows the ticket called there');
select tests.act_as('display');
select is((api.counter_display_snapshot()).guest_first_name, null, 'names stay hidden by default');
select tests.act_as('display2');
select is((api.counter_display_snapshot()).ticket, null, 'Chair 2 does not see Chair 1''s ticket');

select tests.as_postgres();
update app.locations set display_names_enabled = true where id = tests.id('loc_a');
select tests.act_as('display');
select is((api.counter_display_snapshot()).guest_first_name, 'Dana', 'the first name shows once enabled');

select tests.act_as('kiosk');
select is(tests.error_of($$ select api.counter_display_snapshot() $$), 'P0001 not_found', 'a kiosk is denied');
select tests.act_as('staff');
select is(tests.error_of($$ select api.counter_display_snapshot() $$), 'P0001 not_found', 'staff are denied');

select * from finish();
rollback;
