-- 2B-I5 (#310): api_v1 is frozen. Any change to a function's arguments or return type, or to a
-- composite type's attributes, fails here. Additive behaviour goes in a new function or api_v2;
-- see docs/api/v1.md (versioning policy). The expected lists below are the committed snapshot.
begin;
\ir ../helpers/_setup.psql
select plan(3);

select is(
  (select array_agg(p.oid::regprocedure::text || ' returns ' || pg_get_function_result(p.oid)
                    order by p.oid::regprocedure::text)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api_v1'),
  array[
    'api_v1.create_visit(uuid,uuid,text,text,text,integer,uuid) returns api_v1.visit',
    'api_v1.get_queue(uuid) returns api_v1.queue',
    'api_v1.get_visit(uuid) returns api_v1.visit',
    'api_v1.list_queues() returns SETOF api_v1.queue',
    'api_v1.list_visits(uuid,text[],timestamp with time zone,integer) returns SETOF api_v1.visit',
    'api_v1.set_queue_state(uuid,text) returns api_v1.queue',
    'api_v1.transition_visit(uuid,text,integer,uuid,text) returns api_v1.visit'
  ],
  'api_v1 function signatures and return types match the v1 snapshot');

select is(
  (select array_agg(t.typname || '.' || a.attnum || ' ' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                    order by t.typname, a.attnum)
   from pg_type t
   join pg_namespace n on n.oid = t.typnamespace
   join pg_class c on c.oid = t.typrelid and c.relkind = 'c'
   join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where n.nspname = 'api_v1'),
  array[
    'queue.1 id uuid', 'queue.2 location_id uuid', 'queue.3 name text', 'queue.4 state text',
    'queue.5 accepting boolean', 'queue.6 waiting_count integer', 'queue.7 eta_state text',
    'queue.8 eta_low_minutes integer', 'queue.9 eta_high_minutes integer',
    'visit.1 id uuid', 'visit.2 queue_id uuid', 'visit.3 ticket text', 'visit.4 status text',
    'visit.5 party_size integer', 'visit.6 joined_at timestamp with time zone',
    'visit.7 called_at timestamp with time zone', 'visit.8 serving_at timestamp with time zone',
    'visit.9 finished_at timestamp with time zone', 'visit.10 updated_at timestamp with time zone'
  ],
  'api_v1 composite types match the v1 snapshot');

select is(
  (select array_agg(t.typname::text order by t.typname)
   from pg_type t join pg_namespace n on n.oid = t.typnamespace
   join pg_class c on c.oid = t.typrelid and c.relkind = 'c'
   where n.nspname = 'api_v1'),
  array['queue', 'visit'],
  'api_v1 has exactly the two documented object types');

select * from finish();
rollback;
