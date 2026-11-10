-- #1166: the end-of-day figures api.today_stats adds: longest wait and busiest hour.
begin;
\ir ../helpers/_setup.psql
select plan(9);
select tests.create_world();

-- A fresh location on UTC so the local hour is the UTC hour, with one queue. Joining times are
-- fixed offsets from the current hour so the test holds at any time of day.
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_t'), tests.id('org_a'), 'Location T', 'test-location-t', 'Etc/UTC');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_t'), tests.id('org_a'), tests.id('loc_t'), 'T', 'T');

create function tests.move(p_visit text, p_action text, p_status api.visit_state) returns void
language plpgsql as $$
begin
  perform private.set_actor('staff', tests.id('staff'), p_action);
  update app.visits set status = p_status,
    called_at = case when p_status = 'called' then now() else called_at end
  where id = tests.id(p_visit);
end $$;

-- Hour H-5 and H-3 each get three joins (a tie, H-5 is earlier), H-2 gets one. t1 and t4 are
-- called; t2 is called too but that call is undone, and it joined earliest, so it would be the
-- longest wait if it counted.
select tests.new_visit('t' || i, 'queue_t') from generate_series(1, 7) i;
select tests.move('t1', 'call', 'called');
select tests.move('t4', 'call', 'called');
select tests.move('t2', 'call', 'called');
select private.set_actor('system', null);
update app.visits v set joined_at = date_trunc('hour', now()) + x.h * interval '1 hour' + x.m * interval '1 minute'
from (values ('t1', -5, 10), ('t2', -5, 5), ('t3', -5, 20), ('t4', -3, 10), ('t5', -3, 20),
             ('t6', -3, 30), ('t7', -2, 10)) x(n, h, m)
where v.id = tests.id(x.n);
update app.visit_events e set undone_by_event_id = e.id
where e.visit_id = tests.id('t2') and e.to_status = 'called';

create table tests.stats (name text primary key, s api.today_stats);
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.stats to authenticated;

select tests.act_as('manager');
insert into tests.stats values ('m', api.today_stats(tests.id('loc_t')));
select tests.as_postgres();

select is((select (s).longest_wait_minutes from tests.stats where name = 'm'),
  round(extract(epoch from now() - (date_trunc('hour', now()) - interval '5 hours' + interval '10 minutes')) / 60, 1),
  'longest wait is the biggest join-to-first-call gap that was not undone');
select ok((select (s).avg_wait_minutes <= (s).longest_wait_minutes from tests.stats where name = 'm'),
  'the average never exceeds the longest wait');
select is((select (s).busiest_hour from tests.stats where name = 'm'),
  date_trunc('hour', now()) - interval '5 hours',
  'busiest hour is the start of the hour with the most joins; a tie goes to the earlier hour');

-- Staff keep the same access (the card is hidden for them in the UI only).
select tests.act_as('staff');
select ok((api.today_stats(tests.id('loc_t'))).longest_wait_minutes is not null,
  'staff of the location get the figure too');

-- Yesterday's visits never make today's hour busy: pushing the H-5 ones back a service day leaves
-- H-3 busiest.
select tests.as_postgres();
select private.set_actor('system', null);
update app.visits set service_day = service_day - 1 where id in (tests.id('t1'), tests.id('t2'), tests.id('t3'));
select tests.act_as('owner');
select is((api.today_stats(tests.id('loc_t'))).busiest_hour, date_trunc('hour', now()) - interval '3 hours',
  'only the current service day counts toward the busiest hour');

-- An empty day has no figures.
select tests.act_as('other_owner');
select results_eq($$ select (s).longest_wait_minutes, (s).busiest_hour
                     from (select api.today_stats(tests.id('loc_b')) s) x $$,
  $$ values (null::numeric, null::timestamptz) $$, 'an empty day: no longest wait and no busiest hour');
select throws_ok(format($$ select api.today_stats(%L) $$, tests.id('loc_t')), 'P0001', 'not_found',
  'cross-tenant: the owner of org B is denied');
select tests.act_as('display');
select throws_ok(format($$ select api.today_stats(%L) $$, tests.id('loc_t')), 'P0001', 'not_found',
  'a display device is denied (staff only)');
select tests.as_anon();
select throws_ok(format($$ select api.today_stats(%L) $$, tests.id('loc_t')), '42501', null,
  'anon cannot execute it');

select * from finish();
rollback;
