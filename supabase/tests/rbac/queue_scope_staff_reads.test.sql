-- M2c-1 (#1339): queue scope also binds the staff reads that return guest data (visit_history,
-- list_visit_notifications, find_visit_by_scan_code, guest_badges, visit_text_states, search_visits).
-- Setting off = unchanged; setting on = a scoped member sees nothing outside their queues; unscoped staff
-- are unaffected; other tenants see nothing.
begin;
\ir ../helpers/_setup.psql
select plan(30);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
  values (tests.new_id('queue_a2'), tests.id('org_a'), tests.id('loc_a'), 'Second line', 'B');
select tests.create_user('scoped');
insert into app.memberships (org_id, user_id, role, queue_ids)
  values (tests.id('org_a'), tests.id('scoped'), 'staff', array[tests.id('queue_a')]);
select tests.new_visit('own', 'queue_a', 'Zed Own');
select tests.new_visit('other', 'queue_a2', 'Zed Other');
select private.set_actor('system', null);
update app.visits set guest_id = tests.id('guest_a'), scan_code = upper(translate(right(replace(id::text, '-', ''), 10), 'ILOU', '2345'))
  where id in (tests.id('own'), tests.id('other'));
select scan_code as own_code from app.visits where id = tests.id('own') \gset
select scan_code as other_code from app.visits where id = tests.id('other') \gset

-- Can the caller see visit p_v through read function i? Raising not_found counts as no.
create function tests.sees(i int, p_v uuid, p_code text) returns boolean language plpgsql as $$
begin
  case i
    when 1 then perform * from api.visit_history(p_v); return true;
    when 2 then perform * from api.list_visit_notifications(p_v); return true;
    when 3 then perform api.find_visit_by_scan_code(tests.id('loc_a'), p_code); return true;
    when 4 then return exists (select 1 from api.guest_badges(array[p_v]));
    when 5 then return exists (select 1 from api.visit_text_states(tests.id('loc_a')) t where t.visit_id = p_v);
    else return exists (select 1 from api.search_visits(tests.id('loc_a'), 'Zed', 1, 50) r where r.id = p_v);
  end case;
exception when others then
  if sqlerrm = 'not_found' then return false; end if;
  raise;
end $$;
create function tests.case_name(i int) returns text language sql immutable as $$
  select (array['visit_history', 'list_visit_notifications', 'find_visit_by_scan_code', 'guest_badges',
                'visit_text_states', 'search_visits'])[i]
$$;
grant execute on function tests.sees(int, uuid, text), tests.case_name(int) to authenticated;

-- Setting off (default): the member's list is ignored.
select tests.as_user(tests.id('scoped'));
select is(tests.sees(i, tests.id('other'), :'other_code'), true, 'off: ' || tests.case_name(i) || ' outside the list') from generate_series(1, 6) i;

select tests.act_as('admin');
update app.organizations set scope_staff_to_lines = true where id = tests.id('org_a');

-- Setting on, scoped member.
select tests.as_user(tests.id('scoped'));
select is(tests.sees(i, tests.id('other'), :'other_code'), false, 'on: ' || tests.case_name(i) || ' outside the list sees nothing') from generate_series(1, 6) i;
select is(tests.sees(i, tests.id('own'), :'own_code'), true, 'on: ' || tests.case_name(i) || ' in the list') from generate_series(1, 6) i;

-- Unscoped staff are unaffected.
select tests.act_as('staff');
select is(tests.sees(i, tests.id('other'), :'other_code'), true, 'on: unscoped staff ' || tests.case_name(i) || ' on any queue') from generate_series(1, 6) i;

-- Cross tenant.
select tests.act_as('other_owner');
select is(tests.sees(i, tests.id('own'), :'own_code'), false, 'cross-tenant: ' || tests.case_name(i) || ' sees nothing') from generate_series(1, 6) i;

select * from finish();
rollback;
