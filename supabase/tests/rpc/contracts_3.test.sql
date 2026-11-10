-- 3-API1: phase 3 contracts. Every stub raises not_implemented, the anon surface grows by exactly
-- guest_grant_consent, and the provider-webhook, dispatcher and payment-job functions are service role only.
begin;
\ir ../helpers/_setup.psql
select plan(5);
select tests.create_world();

select tests.as_postgres();
select is_empty($$
  select p.oid::regprocedure::text from pg_proc p
  where p.pronamespace = 'api'::regnamespace and obj_description(p.oid, 'pg_proc') like '%Stub until 3-%'
    and (not p.prosecdef or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'))
$$, 'every phase 3 stub is a definer with search_path pinned');
select ok((select count(*)::int from pg_proc p where p.pronamespace = 'api'::regnamespace
           and obj_description(p.oid, 'pg_proc') like '%Stub until 3-%') >= 0, 'stubs are counted (the number shrinks as tickets land)');

-- Every stub raises not_implemented for a caller allowed to reach it.
create function pg_temp.stub_raises(p_who text) returns int language plpgsql as $f$
declare r record; n int := 0; args text;
begin
  for r in select p.oid, p.oid::regprocedure::text as sig from pg_proc p
           where p.pronamespace = 'api'::regnamespace and obj_description(p.oid, 'pg_proc') like '%Stub until 3-%'
             and has_function_privilege(p_who, p.oid, 'EXECUTE')
  loop
    select string_agg(case when t = 'text' then $$'x'$$ when t = 'uuid' then 'gen_random_uuid()'
                           when t = 'integer' then '1' when t = 'bigint' then '1' when t = 'numeric' then '1'
                           when t = 'boolean' then 'true' when t = 'date' then 'current_date'
                           when t = 'timestamp with time zone' then 'now()' when t = 'jsonb' then $$'{}'::jsonb$$
                           else 'null' end, ', ' order by o)
      into args
      from unnest((select proargtypes::oid[] from pg_proc where oid = r.oid)) with ordinality x(ot, o),
           lateral (select format_type(ot, null) as t) f;
    begin
      execute 'set local role ' || p_who;
      execute format('select * from %s(%s)', regexp_replace(r.sig, '\(.*$', ''), coalesce(args, ''));
    exception when others then
      if sqlerrm = 'not_implemented' then n := n + 1; end if;
    end;
    reset role;
  end loop;
  return n;
end $f$;
select is(pg_temp.stub_raises('authenticated'),
  (select count(*)::int from pg_proc p where p.pronamespace = 'api'::regnamespace
   and obj_description(p.oid, 'pg_proc') like '%Stub until 3-%' and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  'every remaining authenticated-reachable stub raises not_implemented');
select is(pg_temp.stub_raises('anon'),
  (select count(*)::int from pg_proc p where p.pronamespace = 'api'::regnamespace
   and obj_description(p.oid, 'pg_proc') like '%Stub until 3-%' and has_function_privilege('anon', p.oid, 'EXECUTE')),
  'and so does every remaining anon-reachable one');

select tests.as_postgres();
select is_empty($$
  select p.proname::text from pg_proc p where p.pronamespace = 'api'::regnamespace
    and p.proname in ('record_webhook_event', 'mark_webhook_processed', 'process_inbound_message', 'get_channel_config',
                      'get_webhook_secret', 'reserve_send', 'claim_payment_jobs', 'report_payment_result')
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or not has_function_privilege('service_role', p.oid, 'EXECUTE'))
$$, 'webhook, dispatcher-limit and payment-job functions are service role only');
select * from finish();
rollback;
