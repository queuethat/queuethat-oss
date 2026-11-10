-- V10 (#39): api.display_snapshot and api.today_stats.
begin;
\ir ../helpers/_setup.psql
select plan(31);
select tests.create_world();

-- Fixtures in loc_a: queue_d with two called and six waiting visits, one leftover visit from
-- yesterday, an archived queue, and four finished visits in queue_a for the counts. A second
-- org A location (loc_a2) has its own staff member and display.
create function tests.move(p_visit text, p_action text, p_status api.visit_state) returns void
language plpgsql as $$
begin
  perform private.set_actor('staff', tests.id('staff'), p_action);
  update app.visits set status = p_status,
    called_at = case when p_status = 'called' then now() else called_at end
  where id = tests.id(p_visit);
end $$;

insert into app.queues (id, org_id, location_id, name, ticket_prefix, sort_order) values
  (tests.new_id('queue_d'), tests.id('org_a'), tests.id('loc_a'), 'Display', 'D', 1);
insert into app.queues (id, org_id, location_id, name, ticket_prefix, archived_at) values
  (tests.new_id('queue_x'), tests.id('org_a'), tests.id('loc_a'), 'Archived', 'X', now());
select tests.new_visit('d' || i, 'queue_d', g)
from unnest(array['Dana Lee', 'Eli Moss', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kim']) with ordinality u(g, i);
select tests.new_visit(s, 'queue_a', 'Stat') from unnest(array['s1', 's2', 's3', 's4']) s;
select private.set_actor('system', null);
insert into app.visits (org_id, location_id, queue_id, service_day, ticket_prefix, ticket_number,
                        display_ticket, status, sort_key, guest_name, guest_token_hash, source,
                        idempotency_key)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_d'),
        private.service_day(tests.id('loc_a')) - 1, 'D', 99, 'D099', 'waiting', 0, 'Yuri Old',
        extensions.digest('yesterday', 'sha256'), 'online', gen_random_uuid());

select private.set_actor('system', null);
update app.visits set joined_at = now() - interval '12 minutes' where id = tests.id('d1');
update app.visits set joined_at = now() - interval '8 minutes' where id = tests.id('d2');
update app.visits set joined_at = now() - interval '10 minutes' where id = tests.id('s1');
select tests.move('d1', 'call', 'called');
select private.set_actor('staff', tests.id('staff'));
update app.visits set counter_id = tests.id('counter_a'), called_at = now() - interval '2 minutes'
where id = tests.id('d1');
select tests.move('d2', 'call', 'called');
select tests.move('s1', 'call', 'called');
select tests.move('s1', 'start', 'serving');
select tests.move('s1', 'complete', 'served');
select tests.move('s2', 'no_show', 'no_show');
select tests.move('s3', 'cancel', 'cancelled');
select tests.move('s4', 'remove', 'removed');

insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_a2'), tests.id('org_a'), 'Location A2', 'test-location-a2', 'America/New_York');
insert into app.memberships (org_id, user_id, role, location_ids)
values (tests.id('org_a'), tests.create_user('staff_a2'), 'staff', array[tests.id('loc_a2')]);
insert into tests.actors values ('staff_a2', 'authenticated',
  jsonb_build_object('sub', tests.id('staff_a2'), 'role', 'authenticated', 'aud', 'authenticated'));
insert into app.devices (org_id, location_id, kind, name, auth_user_id)
values (tests.id('org_a'), tests.id('loc_a2'), 'display', 'TV A2', tests.create_user('display_a2'));
insert into tests.actors values ('display_a2', 'authenticated',
  jsonb_build_object('sub', tests.id('display_a2'), 'role', 'authenticated', 'aud', 'authenticated'));

create table tests.snaps (name text primary key, s api.display_snapshot);
create table tests.stats (name text primary key, s api.today_stats);
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.snaps, tests.stats to authenticated;

------------------------------------------------------------------------------------------------
-- display_snapshot: content
------------------------------------------------------------------------------------------------
select tests.act_as('display');
insert into tests.snaps values ('off', api.display_snapshot(tests.id('loc_a')));
select tests.as_postgres();

select results_eq($$ select (s).location_name, (s).names_enabled, (s).as_of = now() from tests.snaps where name = 'off' $$,
  $$ values ('Location A', false, true) $$, 'the snapshot names the location, names off by default, as_of now');
select is((select array_agg(q.name order by ord) from tests.snaps, unnest((s).queues) with ordinality q(id, name, state, now_serving, next_up, ord) where tests.snaps.name = 'off'),
  array['Walk-ins', 'Display'], 'active queues in sort order; archived queues are left out');
create view tests.dq as
  select tests.snaps.name as snap, q.*
  from tests.snaps, unnest((s).queues) q where q.name = 'Display';

select is((select array_agg(t.display_ticket) from tests.dq, unnest(now_serving) t where snap = 'off'),
  array['D002', 'D001'], 'now serving lists the called tickets, latest call first');
select is((select array_agg(coalesce(t.counter_label, '-')) from tests.dq, unnest(now_serving) t where snap = 'off'),
  array['-', 'Chair 1'], 'now serving carries the counter label');
select is((select array_agg(t.display_ticket) from tests.dq, unnest(next_up) t where snap = 'off'),
  array['D003', 'D004', 'D005', 'D006', 'D007'],
  'next up lists the next 5 waiting tickets in call order; yesterday''s D099 is left out');
select is((select state::text from tests.dq where snap = 'off'), 'open', 'each queue carries its state');
select is((select count(*)::int from tests.snaps, unnest((s).queues) q, unnest(q.now_serving || q.next_up) t
           where tests.snaps.name = 'off' and t.first_name is not null), 0,
  'AC1: with display_names_enabled = false no ticket has a first name');
select is((select count(*)::int from tests.snaps, app.visits v
           where tests.snaps.name = 'off' and strpos(to_jsonb(s)::text, split_part(v.guest_name, ' ', 1)) > 0), 0,
  'AC1: no guest name appears anywhere in the snapshot');

update app.locations set display_names_enabled = true where id = tests.id('loc_a');
select tests.act_as('display');
insert into tests.snaps values ('on', api.display_snapshot(tests.id('loc_a')));
select tests.as_postgres();
select is((select (s).names_enabled from tests.snaps where name = 'on'), true, 'names_enabled follows the location');
select is((select array_agg(t.first_name) from tests.dq, unnest(now_serving || next_up) t where snap = 'on'),
  array['Eli', 'Dana', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo'], 'with names enabled each ticket shows a first name');
select is((select strpos(to_jsonb(s)::text, 'Lee') + strpos(to_jsonb(s)::text, 'Moss') from tests.snaps where name = 'on'), 0,
  'with names enabled, surnames still never appear');

------------------------------------------------------------------------------------------------
-- display_snapshot: who may call it
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select is((api.display_snapshot(tests.id('loc_a'))).location_id, tests.id('loc_a'), 'staff of the location can read it');
select tests.act_as('kiosk');
select is((api.display_snapshot(tests.id('loc_a'))).location_id, tests.id('loc_a'), 'a kiosk of the location can read it');
select tests.act_as('display_a2');
select throws_ok(format($$ select api.display_snapshot(%L) $$, tests.id('loc_a')), 'P0001', 'not_found',
  'AC2: a display of another location of the same org is denied');
select is((api.display_snapshot(tests.id('loc_a2'))).location_name, 'Location A2', 'that display reads its own location');
select tests.act_as('staff_a2');
select throws_ok(format($$ select api.display_snapshot(%L) $$, tests.id('loc_a')), 'P0001', 'not_found',
  'staff limited to another location are denied');
select tests.act_as('other_owner');
select throws_ok(format($$ select api.display_snapshot(%L) $$, tests.id('loc_a')), 'P0001', 'not_found',
  'cross-tenant: the owner of org B is denied');
select throws_ok($$ select api.display_snapshot(gen_random_uuid()) $$, 'P0001', 'not_found',
  'an unknown location raises not_found');
select tests.as_anon();
select throws_ok(format($$ select api.display_snapshot(%L) $$, tests.id('loc_a')), '42501', null,
  'anon cannot execute it');

------------------------------------------------------------------------------------------------
-- today_stats
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
insert into tests.stats values ('a', api.today_stats(tests.id('loc_a')));
select tests.as_postgres();
select results_eq($$ select (s).service_day = private.service_day(tests.id('loc_a')), (s).waiting_now, (s).served,
                            (s).no_shows, (s).cancelled, (s).as_of = now() from tests.stats where name = 'a' $$,
  $$ values (true, 7, 1, 1, 1, true) $$,
  'counts today: 7 waiting (yesterday''s leftover excluded), 1 served, 1 no-show, 1 cancelled; removed is not counted');
select is((select (s).avg_wait_minutes from tests.stats where name = 'a'), 10.0::numeric,
  'average wait is join to first call over called visits: (12 + 8 + 10) / 3');
select is((select (s).joined from tests.stats where name = 'a'), 13,
  'joined today counts every visit that came in, removed ones too: 8 in queue_d, 4 + visit_a in queue_a; not yesterday''s');

-- Undoing d2's call takes its wait out of the average.
update app.visit_events e set undone_by_event_id = e.id
where e.visit_id = tests.id('d2') and e.type = 'call';
select tests.act_as('manager');
select is((api.today_stats(tests.id('loc_a'))).avg_wait_minutes, 11.0::numeric,
  'an undone call does not end a wait: (12 + 10) / 2');

select tests.act_as('other_owner');
select results_eq($$ select (s).waiting_now, (s).served, (s).avg_wait_minutes
                     from (select api.today_stats(tests.id('loc_b')) s) x $$,
  $$ values (0, 0, null::numeric) $$, 'an empty day: zero counts and no average yet');
select throws_ok(format($$ select api.today_stats(%L) $$, tests.id('loc_a')), 'P0001', 'not_found',
  'cross-tenant: the owner of org B is denied');
select tests.act_as('staff_a2');
select throws_ok(format($$ select api.today_stats(%L) $$, tests.id('loc_a')), 'P0001', 'not_found',
  'staff limited to another location are denied');
select tests.act_as('display');
select throws_ok(format($$ select api.today_stats(%L) $$, tests.id('loc_a')), 'P0001', 'not_found',
  'a display of the location is denied (staff only)');
select tests.act_as('kiosk');
select throws_ok(format($$ select api.today_stats(%L) $$, tests.id('loc_a')), 'P0001', 'not_found',
  'a kiosk of the location is denied (staff only)');
select tests.as_anon();
select throws_ok(format($$ select api.today_stats(%L) $$, tests.id('loc_a')), '42501', null,
  'anon cannot execute it');

select tests.as_postgres();
select is((select count(*)::int from app.visits where location_id = tests.id('loc_a')
           and status = 'waiting' and service_day = private.service_day(tests.id('loc_a'))), 7,
  'fixture check: the waiting count matches the table');
select ok(not has_function_privilege('anon', 'api.today_stats(uuid)', 'execute')
          and not has_function_privilege('anon', 'api.display_snapshot(uuid)', 'execute'),
  'neither function is granted to anon');

select * from finish();
rollback;
