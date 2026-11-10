-- 2B-R5 (#296): api.location_comparison values, restricted members and cross-tenant denial.
begin;
\ir ../helpers/_setup.psql
select plan(7);
select tests.create_world();

create function tests.cmp_visit(p_loc text, p_n int, p_status api.visit_state, p_wait_s int, p_service_s int, p_lo int, p_hi int)
returns void language plpgsql as $$
declare
  q app.queues := (select q from app.queues q where q.id = tests.id('queue_a'));
  j timestamptz := '2026-03-02 15:00+00'::timestamptz + make_interval(mins => p_n);
begin
  perform private.set_actor('system', null);
  insert into app.visits (org_id, location_id, queue_id, service_day, ticket_prefix, ticket_number,
                          display_ticket, status, sort_key, guest_name, guest_token_hash, source,
                          idempotency_key, joined_at, called_at, serving_at, finished_at, eta_quoted_low, eta_quoted_high)
  values (q.org_id, tests.id(p_loc), q.id, '2026-03-02', 'C', p_n, 'C' || p_n, p_status, p_n, 'G',
          extensions.digest(gen_random_uuid()::text, 'sha256'), 'online', gen_random_uuid(), j,
          j + make_interval(secs => p_wait_s), j + make_interval(secs => p_wait_s),
          j + make_interval(secs => p_wait_s + p_service_s), p_lo, p_hi);
end $$;

alter table app.visits disable trigger user;
-- loc_a: waits 5 and 15 min (quotes 0-10 and 10-20: both inside? 5 yes, 15 yes), a no-show, a served 10 min.
select tests.cmp_visit('loc_a', 1, 'served', 300, 600, 0, 10);
select tests.cmp_visit('loc_a', 2, 'served', 900, 600, 10, 20);
select tests.cmp_visit('loc_a', 3, 'no_show', 1200, 0, 0, 10);
select tests.cmp_visit('loc_a', 4, 'cancelled', 0, 0, 0, 10);
update app.visits set called_at = null, serving_at = null, finished_at = joined_at + interval '2 minutes' where display_ticket = 'C4';
insert into app.visit_feedback (org_id, location_id, visit_id, rating)
select org_id, location_id, id, case display_ticket when 'C1' then 4 else 5 end from app.visits where display_ticket in ('C1', 'C2');
alter table app.visits enable trigger user;

select tests.act_as('owner');
select results_eq($$ select visits, avg_wait_min, avg_service_min, no_show_pct, within_eta_pct
  from api.location_comparison(tests.id('org_a'), '2026-03-01', '2026-03-03') where location_id = tests.id('loc_a') $$,
  $$ values (4, 13.3, 10.0, 33.3, 66.7) $$,
  'AC1: a location row matches the hand-computed figures (the 20 min wait missed its 0 to 10 quote)');
select results_eq($$ select median_service_min, abandonment_pct, avg_rating
  from api.location_comparison(tests.id('org_a'), '2026-03-01', '2026-03-03') where location_id = tests.id('loc_a') $$,
  $$ values (10.0, 25.0, 4.5) $$, 'AC1 (#296): median service, abandonment (1 of 4 left) and average rating (4 and 5)');
select is((select visits from api.location_comparison(tests.id('org_a'), '2026-03-01', '2026-03-03')
           where location_id = tests.id('loc_a')), 4, 'visits are counted per location');

select tests.as_postgres();
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_a2'), tests.id('org_a'), 'Second', 'second-a', 'Europe/Berlin');
select tests.act_as('owner');
select is((select count(*)::int from api.location_comparison(tests.id('org_a'), '2026-03-01', '2026-03-03')), 2,
  'an owner sees every location, including ones without visits');

select tests.as_postgres();
update app.memberships set location_ids = array[tests.id('loc_a2')] where user_id = tests.id('admin');
select tests.act_as('admin');
select results_eq($$ select location_id from api.location_comparison(tests.id('org_a'), '2026-03-01', '2026-03-03') $$,
  $$ values (tests.id('loc_a2')) $$, 'AC2: an admin restricted to one location gets one row');
select tests.act_as('other_owner');
select is_empty($$ select 1 from api.location_comparison(tests.id('org_a'), '2026-03-01', '2026-03-03') $$,
  'AC3: another org gets zero rows');
select tests.act_as('staff');
select is_empty($$ select 1 from api.location_comparison(tests.id('org_a'), '2026-03-01', '2026-03-03') $$,
  'staff get zero rows');

select * from finish();
rollback;
