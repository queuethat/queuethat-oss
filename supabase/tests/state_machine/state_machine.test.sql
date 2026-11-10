-- S3 (#24): the visit state machine, event writing, append-only log, delete ban and audit.
begin;
\ir ../helpers/_setup.psql
select plan(14);
select tests.create_world();

-- Applies p_action to a fresh visit forced into p_from; returns the new status or the error message.
create function tests.try_transition(p_from api.visit_state, p_action api.visit_action) returns text
language plpgsql as $$
declare vid uuid; result text;
begin
  begin
    vid := tests.new_visit('tt_' || p_from || '_' || p_action || '_' || gen_random_uuid(), 'queue_a');
    -- Put the visit in p_from without the guard (fixture setup only).
    alter table app.visits disable trigger guard_visit;
    update app.visits set status = p_from where id = vid;
    alter table app.visits enable trigger guard_visit;
    perform private.set_actor('staff', tests.id('staff'), p_action::text);
    update app.visits
       set status = coalesce((select to_status from app.visit_transitions
                              where from_status = p_from and action = p_action), 'served')
     where id = vid
    returning status::text into result;
    raise exception using errcode = 'QMPRB', message = result;
  exception
    when sqlstate 'QMPRB' then result := sqlerrm;
    when raise_exception then result := sqlerrm;
  end;
  return result;
end $$;

-- Every (from, action) pair: legal pairs reach their target, every other pair is rejected.
select is_empty($$
  select s, a, tests.try_transition(s, a) as got,
         coalesce((select to_status::text from app.visit_transitions where from_status = s and action = a),
                  'illegal_transition') as want
  from unnest(enum_range(null::api.visit_state)) s, unnest(enum_range(null::api.visit_action)) a
  where tests.try_transition(s, a) <> coalesce(
          (select to_status::text from app.visit_transitions where from_status = s and action = a),
          'illegal_transition')
$$, 'every status x action pair either follows visit_transitions or raises illegal_transition');

-- Specific acceptance criteria.
select tests.as_postgres();
alter table app.visits disable trigger guard_visit;
update app.visits set status = 'served' where id = tests.id('visit_a');
alter table app.visits enable trigger guard_visit;
select private.set_actor('staff', tests.id('owner'), 'requeue');
select throws_ok($$ update app.visits set status = 'waiting' where id = tests.id('visit_a') $$,
  'P0001', 'illegal_transition', 'served -> waiting is illegal for any caller');
select private.set_actor('staff', tests.id('owner'), null);
select throws_ok($$ update app.visits set status = 'waiting' where id = tests.id('visit_a') $$,
  'P0001', 'illegal_transition', 'a status change without an action is illegal');

select set_config('app.actor_kind', '', true);
select throws_ok($$ update app.visits set guest_name = 'x' where id = tests.id('visit_a') $$,
  'P0001', 'missing_actor_context', 'an update without actor context fails loudly');

-- Events
select tests.new_visit('ev', 'queue_a');
select private.set_actor('staff', tests.id('staff'), 'call', null, '{"counter": "Chair 1"}');
update app.visits set status = 'called' where id = tests.id('ev');
select results_eq(
  $$ select type, from_status::text, to_status::text, actor_kind::text, actor_id, payload
     from app.visit_events where visit_id = tests.id('ev') order by id $$,
  $$ values ('joined', null::text, 'waiting', 'system', null::uuid, '{}'::jsonb),
            ('call', 'waiting', 'called', 'staff', tests.id('staff'), '{"counter": "Chair 1"}'::jsonb) $$,
  'join and call each wrote one attributed event');
select is((select version from app.visits where id = tests.id('ev')), 1, 'version increments on change');
select private.set_actor('staff', tests.id('staff'), null);
update app.visits set guest_name = 'Sam' where id = tests.id('ev');
select is((select type from app.visit_events where visit_id = tests.id('ev') order by id desc limit 1),
  'updated', 'a non-status edit still writes an event');

-- Append-only and no deletes, even for the superuser.
select throws_ok($$ delete from app.visits where id = tests.id('ev') $$, '42501', null,
  'visits cannot be deleted');
select throws_ok($$ update app.visit_events set reason = 'x' where visit_id = tests.id('ev') $$, '42501', null,
  'visit_events cannot be edited');
select throws_ok($$ delete from app.visit_events where visit_id = tests.id('ev') $$, '42501', null,
  'visit_events cannot be deleted');
select lives_ok($$ update app.visit_events set undone_by_event_id = id
                   where id = (select min(id) from app.visit_events where visit_id = tests.id('ev')) $$,
  'the undo marker can be set once');

select tests.act_as('owner');
select throws_ok($$ delete from app.visits where id = tests.id('visit_a') $$, '42501', null,
  'owners cannot delete visits');

-- Audit
select tests.act_as('admin');
update app.queues set name = 'Walk-ins (main)' where id = tests.id('queue_a');
select tests.as_postgres();
select results_eq(
  $$ select actor, role, action, before ->> 'name', after ->> 'name' from app.audit_log
     where table_name = 'queues' and row_id = tests.id('queue_a')::text and action = 'UPDATE' $$,
  $$ values (tests.id('admin'), 'admin', 'UPDATE', 'Walk-ins', 'Walk-ins (main)') $$,
  'an admin edit to a queue records actor, role, before and after');
select is((select count(*) from cron.job where jobname = 'purge-idempotency-keys'), 1::bigint,
  'idempotency keys are purged by pg_cron');

select * from finish();
rollback;
