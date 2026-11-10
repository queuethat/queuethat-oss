-- #529: the TV re-highlights a recall (called_at follows the latest call event) and refetches
-- when the location's display settings change.
begin;
\ir ../helpers/_setup.psql
select plan(12);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
select tests.new_visit('visit_b', 'queue_a', 'Bea Second');

create function tests.flush() returns void
language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
end $$;
-- Moves a visit's events back in time; visit_events is append-only, so its triggers are bypassed.
create function tests.age_events(p_visit text, p_age interval) returns void language plpgsql as $$
begin
  set local session_replication_role = replica;
  update app.visit_events set occurred_at = occurred_at - p_age where visit_id = tests.id(p_visit);
  set local session_replication_role = origin;
end $$;
create function tests.act(p_visit text, p_action api.visit_action) returns bigint language sql as $$
  select (api.transition_visit(tests.id(p_visit), p_action,
          (select version from app.visits where id = tests.id(p_visit)), gen_random_uuid())).last_event_id
$$;
-- The display's now-serving list for queue_a as (ticket, called_at) rows, latest first.
create function tests.now_serving() returns table (display_ticket text, called_at timestamptz, ord bigint)
language sql as $$
  select t.display_ticket, t.called_at, t.ord
  from unnest((api.display_snapshot(tests.id('loc_a'))).queues) q,
       unnest(q.now_serving) with ordinality t(display_ticket, counter_label, first_name, called_at, ord)
  where q.id = tests.id('queue_a')
$$;
create table tests.keys (name text primary key, called_at timestamptz);
grant select, insert on tests.keys to authenticated;
grant execute on all functions in schema tests to authenticated;

------------------------------------------------------------------------------------------------
-- A recall changes called_at and moves the ticket first; an undone recall changes it back
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select api.call_next(tests.id('queue_a'), tests.id('counter_a'), gen_random_uuid());
select tests.as_postgres();
select tests.age_events('visit_a', interval '5 minutes');
select tests.act_as('staff');
select api.call_next(tests.id('queue_a'), tests.id('counter_a'), gen_random_uuid());
select tests.as_postgres();
select tests.age_events('visit_b', interval '3 minutes');

create table tests.tickets as
  select (select display_ticket from app.visits where id = tests.id('visit_a')) as a,
         (select display_ticket from app.visits where id = tests.id('visit_b')) as b;
grant select on tests.tickets to authenticated;

select tests.act_as('display');
insert into tests.keys select 'first call', called_at from tests.now_serving() where ord = 2;
select is((select array_agg(display_ticket order by ord) from tests.now_serving()),
  (select array[b, a] from tests.tickets),
  'before a recall, the latest call is first');

select tests.act_as('staff');
select tests.act('visit_a', 'recall') is not null as recalled;
select tests.act_as('display');
select isnt((select called_at from tests.now_serving() where display_ticket =
              (select a from tests.tickets)),
  (select called_at from tests.keys where name = 'first call'),
  'AC: a recall gives the ticket a new called_at, so the board highlights it again');
select is((select called_at from tests.now_serving() where ord = 1), now(),
  'the recalled ticket''s called_at is the recall time');
select is((select display_ticket from tests.now_serving() where ord = 1),
  (select a from tests.tickets),
  'the recalled ticket moves to the front');
select tests.as_postgres();
select is((select call_count from app.visits where id = tests.id('visit_a')), 2,
  'the recall counted (call_count is 2)');

select tests.act_as('staff');
select api.undo_event((select max(id) from app.visit_events where visit_id = tests.id('visit_a')),
                      gen_random_uuid()) is not null as undone;
select tests.act_as('display');
select is((select called_at from tests.now_serving() where display_ticket =
            (select a from tests.tickets)),
  (select called_at from tests.keys where name = 'first call'),
  'an undone recall restores the previous call time, so nothing flashes again');
select is((select ord from tests.now_serving() where display_ticket =
            (select a from tests.tickets)), 2::bigint,
  'and the ticket goes back behind the later call');
select tests.as_postgres();

------------------------------------------------------------------------------------------------
-- Display settings changes signal the location's boards
------------------------------------------------------------------------------------------------
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_a2'), tests.id('org_a'), tests.id('loc_a'), 'Pickups', 'P');
insert into app.queues (id, org_id, location_id, name, ticket_prefix, archived_at) values
  (tests.new_id('queue_ax'), tests.id('org_a'), tests.id('loc_a'), 'Old', 'X', now());
select tests.flush();
delete from realtime.messages;

select tests.act_as('owner');
update app.locations set display_names_enabled = true where id = tests.id('loc_a');
select tests.as_postgres();
select is((select count(*) from realtime.messages), 0::bigint, 'nothing is sent before commit');
select tests.flush();
select is((select array_agg((payload ->> 'queue_id')::uuid order by payload ->> 'queue_id')
           from realtime.messages where event = 'signal' and topic = 'loc:' || tests.id('loc_a')),
  (select array_agg(id order by id::text) from app.queues
   where location_id = tests.id('loc_a') and archived_at is null),
  'AC: turning names on sends one loc: signal per active queue of the location');
select is((select count(*) from realtime.messages
           where event = 'signal' and (payload ->> 'visit_id') is not null), 0::bigint,
  'the signal names no visit');

delete from realtime.messages;
select tests.act_as('owner');
update app.locations set name = name where id = tests.id('loc_a');
update app.locations set display_names_enabled = true where id = tests.id('loc_a');
select tests.as_postgres();
select tests.flush();
select is((select count(*) from realtime.messages), 0::bigint,
  'an update that changes nothing the board shows sends nothing');

delete from realtime.messages;
update app.locations set name = 'Renamed' where id = tests.id('loc_b');
select tests.flush();
select is((select count(*) from realtime.messages where topic = 'loc:' || tests.id('loc_a')), 0::bigint,
  'cross-tenant: another org''s location change never signals this location''s boards');

select * from finish();
rollback;
