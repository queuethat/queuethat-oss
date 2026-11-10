-- M2c-2 (#1339): queue scope also binds log_manual_contact, advance_journey, set_visit_answers and send_queue_message. Setting off = unchanged; setting on =
-- a scoped member outside their queues gets not_found; in-scope, unscoped staff are unaffected; other
-- tenants always get not_found. "Not not_found" is asserted where a call can fail for another reason.
begin;
\ir ../helpers/_setup.psql
select plan(20);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
  values (tests.new_id('queue_a2'), tests.id('org_a'), tests.id('loc_a'), 'Second line', 'B');
select tests.create_user('scoped');
insert into app.memberships (org_id, user_id, role, queue_ids)
  values (tests.id('org_a'), tests.id('scoped'), 'staff', array[tests.id('queue_a')]);
select tests.new_visit('own', 'queue_a');
select tests.new_visit('other', 'queue_a2');

create function tests.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then return sqlerrm;
end $$;
grant execute on function tests.err(text) to authenticated;
-- Case i of the seven staff functions, aimed at visit p_v of queue p_q.
create function tests.staff_case(i int, p_v uuid, p_q uuid) returns text language sql as $$
  select tests.err(case i
    when 1 then format($f$ select api.log_manual_contact(%L, 'sms') $f$, p_v)
    when 2 then format($f$ select api.advance_journey(%L, 1, gen_random_uuid()) $f$, p_v)
    when 3 then format($f$ select api.set_visit_answers(%L, '{}'::jsonb, 1, gen_random_uuid()) $f$, p_v)
    else format($f$ select api.send_queue_message(%L, 'hello', gen_random_uuid()) $f$, p_q) end)
$$;
grant execute on function tests.staff_case(int, uuid, uuid) to authenticated;
create function tests.case_name(i int) returns text language sql immutable as $$
  select (array['log_manual_contact', 'advance_journey', 'set_visit_answers', 'send_queue_message'])[i]
$$;
grant execute on function tests.case_name(int) to authenticated;

-- Setting off (default): the member's list is ignored.
select tests.as_user(tests.id('scoped'));
select isnt(tests.staff_case(i, tests.id('other'), tests.id('queue_a2')), 'not_found', 'off: ' || tests.case_name(i) || ' outside the list')
  from generate_series(1, 4) i;

select tests.act_as('admin');
update app.organizations set scope_staff_to_lines = true where id = tests.id('org_a');

-- Setting on, scoped member.
select tests.as_user(tests.id('scoped'));
select is(tests.staff_case(i, tests.id('other'), tests.id('queue_a2')), 'not_found', 'on: ' || tests.case_name(i) || ' outside the list is not_found')
  from generate_series(1, 4) i;
select isnt(tests.staff_case(i, tests.id('own'), tests.id('queue_a')), 'not_found', 'on: ' || tests.case_name(i) || ' in the list')
  from generate_series(1, 4) i;

-- Unscoped staff are unaffected.
select tests.act_as('staff');
select isnt(tests.staff_case(i, tests.id('other'), tests.id('queue_a2')), 'not_found', 'on: unscoped staff ' || tests.case_name(i) || ' on any queue')
  from generate_series(1, 4) i;

-- Cross tenant.
select tests.act_as('other_owner');
select is(tests.staff_case(i, tests.id('own'), tests.id('queue_a')), 'not_found', 'cross-tenant: ' || tests.case_name(i) || ' is not_found')
  from generate_series(1, 4) i;

select * from finish();
rollback;
