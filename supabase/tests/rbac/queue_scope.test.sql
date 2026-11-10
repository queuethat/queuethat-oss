-- M1 (#1288): optional queue scope for staff. Setting off = location-wide as before; setting on = scoped
-- members see only their queues; unscoped members see all; other tenants see nothing; no queue cap.
begin;
\ir ../helpers/_setup.psql
select plan(25);
select tests.create_world();

-- A second queue at the same location, a scoped member (queue_a only) and visits in both queues.
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
  values (tests.new_id('queue_a2'), tests.id('org_a'), tests.id('loc_a'), 'Second line', 'B');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
  values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Org B line', 'A');
select tests.create_user('scoped');
insert into app.memberships (org_id, user_id, role, queue_ids)
  values (tests.id('org_a'), tests.id('scoped'), 'staff', array[tests.id('queue_a')]);
select tests.new_visit('va', 'queue_a');
select tests.new_visit('va2', 'queue_a2');
insert into app.visit_answers (visit_id, org_id, location_id, answers) values
  (tests.id('va'), tests.id('org_a'), tests.id('loc_a'), '{"f": "one"}'),
  (tests.id('va2'), tests.id('org_a'), tests.id('loc_a'), '{"f": "two"}');

-- Counts the rows of the two visits this test created (the world holds other visits too).
create function pg_temp.seen(p_table text) returns int language plpgsql as $$
declare n int;
begin
  execute format('select count(*) from app.%I where %I in (%L, %L)', p_table,
    case when p_table = 'visits' then 'id' else 'visit_id' end, tests.id('va'), tests.id('va2')) into n;
  return n;
end $$;
grant execute on function pg_temp.seen(text) to authenticated;
create function pg_temp.access(p_queue text, p_org text default 'org_a') returns boolean language sql as
  $$ select private.has_queue_access(tests.id(p_org), tests.id(p_queue), 'staff') $$;
grant execute on function pg_temp.access(text, text) to authenticated;

-- Setting off (the default): a member's queue list is ignored and nothing changes.
select tests.as_postgres();
select is((select scope_staff_to_lines from app.organizations where id = tests.id('org_a')), false, 'the setting is off by default');
select tests.as_user(tests.id('scoped'));
select is(pg_temp.seen('visits'), 2, 'off: a listed member still sees both queues');
select is(pg_temp.seen('visit_answers'), 2, 'off: and both queues'' answers');
select is(pg_temp.access('queue_a2'), true, 'off: has_queue_access is true for the other queue');
select tests.act_as('staff');
select is(pg_temp.seen('visits'), 2, 'off: unscoped staff see both queues');

-- Only an admin or above can turn it on.
select tests.act_as('staff');
update app.organizations set scope_staff_to_lines = true where id = tests.id('org_a');
select tests.as_postgres();
select is((select scope_staff_to_lines from app.organizations where id = tests.id('org_a')), false, 'staff cannot change the setting');
select tests.act_as('admin');
update app.organizations set scope_staff_to_lines = true where id = tests.id('org_a');
select tests.as_postgres();
select is((select scope_staff_to_lines from app.organizations where id = tests.id('org_a')), true, 'an admin turns the setting on');

-- Setting on: the scoped member is limited, everyone else is not.
select tests.as_user(tests.id('scoped'));
select is(pg_temp.seen('visits'), 1, 'on: a scoped member sees one visit');
select is((select queue_id from app.visits where id in (tests.id('va'), tests.id('va2'))), tests.id('queue_a'), 'on: it is in their queue');
select is(pg_temp.seen('visit_answers'), 1, 'on: and only their queue''s answers');
select is(pg_temp.seen('visit_events'), 1, 'on: visit events follow the visits');
select is(pg_temp.access('queue_a'), true, 'on: access to their own queue');
select is(pg_temp.access('queue_a2'), false, 'on: no access to the other queue');
select is(pg_temp.access('queue_b', 'org_a'), false, 'a queue from another org does not pass under this org id');
select tests.act_as('staff');
select is(pg_temp.seen('visits'), 2, 'on: unscoped staff (front desk) see every queue');
select is(pg_temp.seen('visit_answers'), 2, 'on: and every queue''s answers');
select tests.act_as('manager');
select is(pg_temp.seen('visits'), 2, 'on: a manager is unaffected');

-- Cross tenant: the other org's owner sees none of this and gets no access.
select tests.act_as('other_owner');
select is(pg_temp.seen('visits'), 0, 'cross-tenant: no visits');
select is(pg_temp.seen('visit_answers'), 0, 'cross-tenant: no answers');
select is(pg_temp.access('queue_a'), false, 'cross-tenant: no queue access');

-- Assigning scope: owner only, own org's queues only, staff only, never empty.
select tests.act_as('staff');
update app.memberships set queue_ids = null where user_id = tests.id('scoped');
select tests.as_postgres();
select is((select queue_ids from app.memberships where user_id = tests.id('scoped')), array[tests.id('queue_a')], 'staff cannot clear a colleague''s scope');
select tests.act_as('owner');
select tests.act_as('owner');
select throws_ok($$ update app.memberships set queue_ids = array[tests.id('queue_b')] where user_id = tests.id('scoped') $$,
  'P0001', 'invalid_input', 'a queue of another org is rejected');
select throws_ok($$ update app.memberships set queue_ids = '{}' where user_id = tests.id('scoped') $$,
  '23514', null, 'an empty list is rejected (null means all)');
update app.memberships set queue_ids = array[tests.id('queue_a'), tests.id('queue_a2')] where user_id = tests.id('scoped');
update app.memberships set role = 'manager' where user_id = tests.id('scoped');
select tests.as_postgres();
select is((select queue_ids from app.memberships where user_id = tests.id('scoped')), null, 'promotion clears the scope');

-- No queue cap: eight queues at one location create fine (billing counts locations).
insert into app.queues (org_id, location_id, name, ticket_prefix)
  select tests.id('org_a'), tests.id('loc_a'), 'Line ' || n, chr(64 + n) from generate_series(3, 10) n;
select is((select count(*)::int from app.queues where location_id = tests.id('loc_a') and archived_at is null), 10,
  'a location holds ten queues (8 added to the 2 above)');

select * from finish();
rollback;
