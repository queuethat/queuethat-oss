-- 2A-Q10 (#109): the ETA uses learned service durations.
begin;
\ir ../helpers/_setup.psql
select plan(9);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
select tests.new_id(k) from unnest(array['svc','svc12']) k;

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_l'), tests.id('org_a'), tests.id('loc_a'), 'Learned', 'L');
insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes)
values (tests.id('svc'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_l'), 'Haircut', 30),
       (tests.id('svc12'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_l'), 'Shave', 30);

/** Serves p_n visits of service p_svc that each took p_minutes, an hour ago; p_auto marks rollover closes. */
create function tests.serve(p_prefix text, p_svc text, p_n int, p_minutes numeric, p_auto boolean default false)
returns void language plpgsql as $$
declare vid uuid;
begin
  for i in 1..p_n loop
    vid := tests.new_visit(p_prefix || i, 'queue_l');
    perform private.set_actor('system', null, 'call', 'x');
    update app.visits set status = 'called' where id = vid;
    perform private.set_actor('system', null, 'start', 'x');
    update app.visits set status = 'serving', service_id = tests.id(p_svc) where id = vid;
    perform private.set_actor('system', null, 'complete', 'x', case when p_auto then '{"auto_closed": true}'::jsonb else '{}'::jsonb end);
    update app.visits set status = 'served',
      serving_at = now() - interval '1 hour', finished_at = now() - interval '1 hour' + make_interval(mins => p_minutes::int)
    where id = vid;
  end loop;
end $$;

select tests.serve('h', 'svc', 25, 22);
select tests.serve('s', 'svc12', 12, 5);
select tests.serve('r', 'svc12', 20, 6, true);
select tests.serve('x', 'svc12', 3, 300);
select ok(ops.refresh_duration_stats() > 0, 'the refresh writes stats');

select is((select minutes from private.service_minutes(tests.id('svc'))), 22::numeric, 'AC1: 25 samples, median 22: 22 is used, not 30');
select is((select minutes from private.service_minutes(tests.id('svc12'))), 30::numeric, 'AC2: 12 samples: expected_minutes is used');
select is((select samples from private.service_duration_stats where service_id = tests.id('svc12') and hour_bucket is null), 12,
  'AC3: auto-closed visits and durations over 4 hours are not samples');
select is((select sd from private.service_minutes(tests.id('svc'))), 2.2, 'a flat history keeps a floor of a tenth of the median');
select is((select minutes from private.service_minutes(gen_random_uuid())), null, 'an unknown service has no minutes');

-- ETA uses it: 3 Haircuts waiting, one server: learned 22 min each, so the 3rd waits 44 (not 60); a flat history narrows the range.
select tests.new_visit('w' || i, 'queue_l') from generate_series(1, 3) i;
update app.visits set service_id = tests.id('svc') where id in (tests.id('w1'), tests.id('w2'), tests.id('w3'));
select is((select eta_low || '-' || eta_high from private.visit_eta(tests.id('w3'))), '40-50', 'the ETA is built from the learned median and its narrow spread (expected minutes would say 30-90)');

-- AC4: nobody reads the stats.
select tests.act_as('staff');
select throws_ok($$ select count(*) from private.service_duration_stats $$, '42501', null, 'AC4: authenticated is denied');
select tests.as_anon();
select throws_ok($$ select count(*) from private.service_duration_stats $$, '42501', null, 'and anon is denied');

select * from finish();
rollback;
