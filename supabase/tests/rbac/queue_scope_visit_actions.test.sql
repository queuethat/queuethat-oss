-- M2b-1 (#1329): queue scope also binds undo_event, assign_visit, update_visit_notes, set_visit_priority.
-- Setting off = unchanged. Setting on = a scoped member outside their queues gets not_found; unscoped
-- staff are unaffected; other tenants always get not_found.
begin;
\ir ../helpers/_setup.psql
select plan(19);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
  values (tests.new_id('queue_a2'), tests.id('org_a'), tests.id('loc_a'), 'Second line', 'B');
insert into app.priority_classes (id, org_id, location_id, name, offset_minutes)
  values (tests.new_id('pc'), tests.id('org_a'), tests.id('loc_a'), 'Elderly', 30);
select tests.create_user('scoped');
insert into app.memberships (org_id, user_id, role, queue_ids)
  values (tests.id('org_a'), tests.id('scoped'), 'staff', array[tests.id('queue_a')]);
select tests.new_id(k) from unnest(array['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10', 'k11', 'k12', 'k13', 'k14']) k;
-- own queue: i1, i2. other queue: x1, x2. Each action below targets its own visit so versions never clash.
select tests.new_visit(n, 'queue_a') from unnest(array['i1', 'i2', 'i3', 'i4']) n;
select tests.new_visit(n, 'queue_a2') from unnest(array['x1', 'x2', 'x3', 'x4', 'x5']) n;

create function tests.ver(p_visit text) returns int language sql as $$
  select version from app.visits where id = tests.id(p_visit)
$$;
create function tests.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then return sqlerrm;
end $$;
grant execute on function tests.ver(text), tests.err(text) to authenticated;

-- Events to undo: one call in each queue, made by unscoped staff while the setting is off.
select tests.act_as('staff');
select api.transition_visit(tests.id('x5'), 'call', tests.ver('x5'), tests.id('k1'));
select api.transition_visit(tests.id('i4'), 'call', tests.ver('i4'), tests.id('k2'));
select tests.as_postgres();
select max(id) as xev from app.visit_events where visit_id = tests.id('x5') \gset
select max(id) as iev from app.visit_events where visit_id = tests.id('i4') \gset

-- Setting off (default): the member's list is ignored.
select tests.as_user(tests.id('scoped'));
select is(tests.err($$ select api.assign_visit(tests.id('x1'), null, null, tests.ver('x1'), tests.id('k3')) $$), 'ok', 'off: assign_visit outside the list works');
select is(tests.err($$ select api.update_visit_notes(tests.id('x1'), 'note', null, tests.ver('x1'), tests.id('k4')) $$), 'ok', 'off: update_visit_notes outside the list works');
select is(tests.err($$ select api.set_visit_priority(tests.id('x2'), tests.id('pc'), tests.ver('x2'), tests.id('k5')) $$), 'ok', 'off: set_visit_priority outside the list works');
select is(tests.err(format($$ select api.undo_event(%s, tests.id('k6')) $$, :xev)), 'ok', 'off: undo_event outside the list works');

-- An admin turns the setting on; unscoped staff re-call x5 so there is something to undo again.
select tests.act_as('admin');
update app.organizations set scope_staff_to_lines = true where id = tests.id('org_a');
select tests.act_as('staff');
select api.transition_visit(tests.id('x5'), 'call', tests.ver('x5'), tests.id('k7'));
select tests.as_postgres();
select max(id) as xev from app.visit_events where visit_id = tests.id('x5') \gset

-- Setting on, scoped member, outside the list.
select tests.as_user(tests.id('scoped'));
select is(tests.err($$ select api.assign_visit(tests.id('x3'), null, null, tests.ver('x3'), tests.id('k8')) $$), 'not_found', 'on: assign_visit outside the list is not_found');
select is(tests.err($$ select api.update_visit_notes(tests.id('x3'), 'note', null, tests.ver('x3'), tests.id('k9')) $$), 'not_found', 'on: update_visit_notes outside the list is not_found');
select is(tests.err($$ select api.set_visit_priority(tests.id('x3'), tests.id('pc'), tests.ver('x3'), tests.id('k10')) $$), 'not_found', 'on: set_visit_priority outside the list is not_found');
select is(tests.err(format($$ select api.undo_event(%s, tests.id('k11')) $$, :xev)), 'not_found', 'on: undo_event outside the list is not_found');

-- Setting on, scoped member, inside the list: works, replay is idempotent.
select is(tests.err($$ select api.assign_visit(tests.id('i1'), null, null, tests.ver('i1'), tests.id('k12')) $$), 'ok', 'on: assign_visit in the list works');
select is(tests.err($$ select api.update_visit_notes(tests.id('i2'), 'note', null, tests.ver('i2'), tests.id('k13')) $$), 'ok', 'on: update_visit_notes in the list works');
select is(tests.err($$ select api.set_visit_priority(tests.id('i3'), tests.id('pc'), tests.ver('i3'), tests.id('k14')) $$), 'ok', 'on: set_visit_priority in the list works');
select is(tests.err(format($$ select api.undo_event(%s, tests.id('k1')) $$, :iev)), 'ok', 'on: undo_event in the list works');
select is((select count(*)::int from app.visits where id in (tests.id('x3')) and notes is not null), 0, 'on: and the blocked note was not written');

-- Unscoped staff are unaffected.
select tests.act_as('staff');
select is(tests.err($$ select api.update_visit_notes(tests.id('x3'), 'note', null, tests.ver('x3'), tests.id('k8')) $$), 'ok', 'on: unscoped staff update notes on any queue');
select is(tests.err($$ select api.set_visit_priority(tests.id('x4'), tests.id('pc'), tests.ver('x4'), tests.id('k9')) $$), 'ok', 'on: unscoped staff set priority on any queue');

-- Cross tenant.
select tests.act_as('other_owner');
select is(tests.err($$ select api.assign_visit(tests.id('i1'), null, null, tests.ver('i1'), gen_random_uuid()) $$), 'not_found', 'cross-tenant: assign_visit is not_found');
select is(tests.err($$ select api.update_visit_notes(tests.id('i1'), 'x', null, tests.ver('i1'), gen_random_uuid()) $$), 'not_found', 'cross-tenant: update_visit_notes is not_found');
select is(tests.err($$ select api.set_visit_priority(tests.id('i1'), tests.id('pc'), tests.ver('i1'), gen_random_uuid()) $$), 'not_found', 'cross-tenant: set_visit_priority is not_found');
select is(tests.err(format($$ select api.undo_event(%s, gen_random_uuid()) $$, :iev)), 'not_found', 'cross-tenant: undo_event is not_found');

select * from finish();
rollback;
