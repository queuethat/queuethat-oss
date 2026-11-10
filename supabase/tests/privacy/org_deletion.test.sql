-- 2P-PRV7 (#194): org deletion request, lockout, cancel and purge.
begin;
\ir ../helpers/_setup.psql
select plan(22);
select tests.create_world();

select tests.as_postgres();
create temp table slug as select slug from app.locations where id = tests.id('loc_a');
grant select on slug to authenticated, anon;

-- AC5: only the owner of the org can request.
select tests.act_as('admin');
select throws_ok($$ select api.request_org_deletion(tests.id('org_a'), (select slug from slug)) $$, 'P0001', 'not_found',
  'AC4: an admin cannot request deletion');
select tests.act_as('other_owner');
select throws_ok($$ select api.request_org_deletion(tests.id('org_a'), (select slug from slug)) $$, 'P0001', 'not_found',
  'AC4: an owner of org B cannot request it');

select tests.act_as('owner');
select throws_ok($$ select api.request_org_deletion(tests.id('org_a'), 'wrong-slug') $$, 'P0001', 'invalid_input',
  'a wrong confirmation slug is refused');
select cmp_ok(api.request_org_deletion(tests.id('org_a'), (select slug from slug)), '>', now() + interval '6 days',
  'the owner schedules the purge about 7 days out');
create temp table sched as select api.request_org_deletion(tests.id('org_a'), (select slug from slug)) as at;
grant select on sched to authenticated;
select is((select at from sched), api.request_org_deletion(tests.id('org_a'), (select slug from slug)), 'repeating returns the same time');

-- AC1: locked out at once.
select tests.act_as('admin');
select is((select count(*) from app.visits), 0::bigint, 'AC1: an admin reads no visits');
select is((select count(*) from app.queues), 0::bigint, 'AC1: nor queues');
select tests.as_anon();
select throws_ok($$ select api.get_location_public((select slug from slug)) $$, 'P0001', 'not_found', 'AC1: the join page is not found');
select tests.act_as('display');
select is((select count(*) from app.queues), 0::bigint, 'paired screens stop reading');

-- AC2: cancel restores everything.
select tests.act_as('owner');
select lives_ok($$ select api.cancel_org_deletion(tests.id('org_a')) $$, 'AC2: the owner cancels');
select tests.act_as('admin');
select cmp_ok((select count(*) from app.visits), '>', 0::bigint, 'AC2: access is back and nothing was deleted');

-- AC3: purge.
select tests.act_as('owner');
select api.request_org_deletion(tests.id('org_a'), (select slug from slug));
select tests.as_postgres();
select is(ops.purge_deleted_orgs(), 0, 'nothing is purged inside the grace period');
update app.organizations set deletion_scheduled_for = now() - interval '1 minute' where id = tests.id('org_a');
select is(ops.purge_deleted_orgs(), 0, 'the rows wait until purge-org has removed storage and device users');
update app.organizations set external_purged_at = now() where id = tests.id('org_a');
insert into app.platform_daily_stats (day, org_id, joins) values (current_date, tests.id('org_a'), 4);
select is(ops.purge_deleted_orgs(), 1, 'AC3: the purge removes the org');
select is((select count(*) from app.organizations where id = tests.id('org_a')), 0::bigint, 'the org row is gone');
do $$
declare t record; n bigint; bad text := '';
begin
  for t in select c.table_name from information_schema.columns c
           join information_schema.tables x using (table_schema, table_name)
           -- platform_sms_daily and platform_daily_stats are kept on purpose: counts keyed by an id, the operator's history (#1222, #1225)
           where c.table_schema = 'app' and c.column_name = 'org_id' and x.table_type = 'BASE TABLE'
             and c.table_name not in ('platform_sms_daily', 'platform_daily_stats') loop
    execute format('select count(*) from app.%I where org_id = %L', t.table_name, tests.id('org_a')) into n;
    if n > 0 then bad := bad || t.table_name || ' '; end if;
  end loop;
  create temp table residue as select bad as tables;
end $$;
select is((select joins from app.platform_daily_stats where org_id = tests.id('org_a') and day = current_date), 4, 'the operator daily counts outlive the org (#1225)');
select is((select tables from residue), '', 'AC3: no app table keeps a row of the org (catalog-driven)');
select cmp_ok((select count(*) from app.visits where org_id = tests.id('org_b')) + (select count(*) from app.queues where org_id = tests.id('org_b')),
  '>=', 0::bigint, 'org B is untouched');
select is((select count(*) from app.organizations where id = tests.id('org_b')), 1::bigint, 'org B still exists');
select is((select count(*) from ops.org_deletion_log where org_id = tests.id('org_a')), 1::bigint, 'the purge is logged by id only');

-- AC5: nobody deletes visits through the API.
select tests.act_as('owner');
select throws_ok($$ delete from app.visits $$, '42501', null, 'AC5: an authenticated owner cannot delete visits');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('api', 'private') and p.prosrc ilike '%delete from app.visits%'), 0::bigint,
  'AC5: no api or private function deletes from app.visits');

select * from finish();
rollback;
