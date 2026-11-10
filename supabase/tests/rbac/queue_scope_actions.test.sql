-- M2 (#1289): the queue scope from M1 also binds the staff actions and the staff-only reads.
-- Setting off = nothing changes. Setting on = a scoped member acting outside their queues gets not_found;
-- unscoped staff and managers are unaffected; other tenants always get not_found.
begin;
\ir ../helpers/_setup.psql
select plan(32);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
  values (tests.new_id('queue_a2'), tests.id('org_a'), tests.id('loc_a'), 'Second line', 'B');
select tests.create_user('scoped');
select tests.new_id(k) from unnest(array['k_off1', 'k_off2', 'k_off3', 'k_off4', 'k_on1', 'k_on10', 'k_on11', 'k_on12', 'k_on13', 'k_on2', 'k_on3', 'k_on4', 'k_on5', 'k_on6', 'k_on7', 'k_on8', 'k_on9', 'k_x1', 'k_x2', 'k_x3', 'k_x4']) k;
insert into app.memberships (org_id, user_id, role, queue_ids)
  values (tests.id('org_a'), tests.id('scoped'), 'staff', array[tests.id('queue_a')]);
-- Own queue: i1..i4. Other queue: x1..x4.
select tests.new_visit(n, 'queue_a') from unnest(array['i1', 'i2', 'i3', 'i4']) n;
select tests.new_visit(n, 'queue_a2') from unnest(array['x1', 'x2', 'x3', 'x4', 'y1', 'y2']) n;

create function tests.ver(p_visit text) returns int language sql as $$
  select version from app.visits where id = tests.id(p_visit)
$$;
-- The queue of the visit call_next called (which visit comes first does not matter here).
create function tests.next_of(p_queue text, p_key text) returns uuid language sql as $$
  select (api.call_next(tests.id(p_queue), null, tests.id(p_key))).queue_id
$$;
create function tests.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then return sqlerrm;
end $$;
grant execute on function tests.ver(text), tests.next_of(text, text), tests.err(text) to authenticated;

-- Payment, feedback and notification rows for one visit per queue.
insert into app.payments (org_id, location_id, visit_id, provider, intent_id, kind, status, amount_minor, currency, idempotency_key)
  select tests.id('org_a'), tests.id('loc_a'), tests.id(n), 'fake', 'pi_' || n, 'hold', 'authorized', 500, 'usd', 'k_' || n
  from unnest(array['i4', 'x4']) n;
insert into app.visit_feedback (org_id, location_id, visit_id, rating)
  select tests.id('org_a'), tests.id('loc_a'), tests.id(n), 4 from unnest(array['i4', 'x4']) n;
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
  select tests.id('org_a'), tests.id(n), 'push', tests.id('push_a'), 'called', 1, 'scope-' || n from unnest(array['i4', 'x4']) n;
create function pg_temp.reads(p_table text) returns int language plpgsql as $$
declare n int;
begin
  execute format('select count(*) from app.%I where visit_id in (%L, %L)', p_table, tests.id('i4'), tests.id('x4')) into n;
  return n;
end $$;
grant execute on function pg_temp.reads(text) to authenticated;

-- Setting off (the default): the member's list is ignored by every action.
select tests.as_user(tests.id('scoped'));
select is(tests.next_of('queue_a2', 'k_off1'), tests.id('queue_a2'), 'off: call_next works on a queue outside the list');
select is((api.transition_visit(tests.id('x2'), 'call', tests.ver('x2'), tests.id('k_off2'))).status::text, 'called',
  'off: transition_visit works outside the list');
select is((api.move_visit(tests.id('x4'), tests.id('x3'), tests.ver('x4'), tests.id('k_off3'))).id, tests.id('x4'),
  'off: move_visit works outside the list');
select is((api.transfer_visit(tests.id('x3'), tests.id('queue_a'), null, tests.ver('x3'), tests.id('k_off4'))).queue_id,
  tests.id('queue_a'), 'off: transfer_visit works across queues');
select is(pg_temp.reads('payments'), 2, 'off: payments of both queues are visible');
select is(pg_temp.reads('visit_feedback'), 2, 'off: feedback of both queues is visible');
select is(pg_temp.reads('notifications'), 2, 'off: notifications of both queues are visible');

-- An admin turns the setting on. x3 moved to queue_a above, so queue_a2 now holds x4 and the called x1, x2.
select tests.act_as('admin');
update app.organizations set scope_staff_to_lines = true where id = tests.id('org_a');

-- Setting on, scoped member, outside the list: not_found for every action.
select tests.as_user(tests.id('scoped'));
select is(tests.err($$ select tests.next_of('queue_a2', 'k_on1') $$), 'not_found', 'on: call_next outside the list is not_found');
select is(tests.err($$ select api.transition_visit(tests.id('y1'), 'call', tests.ver('y1'), tests.id('k_on2')) $$), 'not_found',
  'on: transition_visit outside the list is not_found');
select is(tests.err($$ select api.move_visit(tests.id('y2'), null, tests.ver('y2'), tests.id('k_on3')) $$), 'not_found',
  'on: move_visit outside the list is not_found');
select is(tests.err($$ select api.transfer_visit(tests.id('y1'), tests.id('queue_a'), null, tests.ver('y1'), tests.id('k_on4')) $$), 'not_found',
  'on: transfer_visit of a visit outside the list is not_found');
select is(tests.err($$ select api.transfer_visit(tests.id('i2'), tests.id('queue_a2'), null, tests.ver('i2'), tests.id('k_on5')) $$), 'not_found',
  'on: transfer_visit into a queue outside the list is not_found');
select is((select queue_id from app.visits where id = tests.id('i2')), tests.id('queue_a'), 'on: and the visit did not move');

-- Setting on, scoped member, inside the list: works, and replays are idempotent.
select is(tests.next_of('queue_a', 'k_on6'), tests.id('queue_a'), 'on: call_next works on their own queue');
select is(tests.next_of('queue_a', 'k_on6'), tests.id('queue_a'), 'on: and replaying the same key succeeds');
select is((api.transition_visit(tests.id('i2'), 'call', tests.ver('i2'), tests.id('k_on7'))).status::text, 'called',
  'on: transition_visit works on their own queue');
select is((api.move_visit(tests.id('i3'), null, tests.ver('i3'), tests.id('k_on8'))).id, tests.id('i3'),
  'on: move_visit works on their own queue');
select is((api.transfer_visit(tests.id('i3'), tests.id('queue_a'), null, tests.ver('i3'), tests.id('k_on9'))).queue_id, tests.id('queue_a'),
  'on: transfer_visit within their own queue works');
select is(tests.err($$ select api.undo_event((select max(id) from app.visit_events where visit_id = tests.id('i3')), tests.id('k_on10')) $$),
  'ok', 'on: undo of their own action still works');

-- Reads: only their own queue's rows.
select is(pg_temp.reads('payments'), 1, 'on: scoped member sees one queue''s payments');
select is(pg_temp.reads('visit_feedback'), 1, 'on: and one queue''s feedback');
select is(pg_temp.reads('notifications'), 1, 'on: and one queue''s notifications');

-- Unscoped staff and a manager are unaffected.
select tests.act_as('staff');
select is(tests.next_of('queue_a2', 'k_on11'), tests.id('queue_a2'), 'on: unscoped staff call_next on any queue');
select is(pg_temp.reads('payments') + pg_temp.reads('visit_feedback') + pg_temp.reads('notifications'), 6, 'on: unscoped staff read every queue');
select is((api.transfer_visit(tests.id('y2'), tests.id('queue_a'), null, tests.ver('y2'), tests.id('k_on12'))).queue_id, tests.id('queue_a'),
  'on: unscoped staff transfer into any queue');
select tests.act_as('manager');
select is(tests.next_of('queue_a2', 'k_on13'), tests.id('queue_a2'), 'on: a manager call_next on any queue');
select is(pg_temp.reads('payments'), 2, 'on: a manager reads every queue');

-- Cross tenant: the other org gets not_found from every action and sees no rows.
select tests.act_as('other_owner');
select is(tests.err($$ select tests.next_of('queue_a', 'k_x1') $$), 'not_found', 'cross-tenant: call_next is not_found');
select is(tests.err($$ select api.transition_visit(tests.id('i2'), 'call', tests.ver('i2'), tests.id('k_x2')) $$), 'not_found',
  'cross-tenant: transition_visit is not_found');
select is(tests.err($$ select api.move_visit(tests.id('i2'), null, tests.ver('i2'), tests.id('k_x3')) $$), 'not_found',
  'cross-tenant: move_visit is not_found');
select is(tests.err($$ select api.transfer_visit(tests.id('i2'), tests.id('queue_a2'), null, tests.ver('i2'), tests.id('k_x4')) $$), 'not_found',
  'cross-tenant: transfer_visit is not_found');
select is(pg_temp.reads('payments') + pg_temp.reads('visit_feedback') + pg_temp.reads('notifications'), 0, 'cross-tenant: no rows');

select * from finish();
rollback;
