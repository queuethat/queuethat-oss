-- 2P-PRV8 (#195): what the purge-org Edge Function may ask the database.
begin;
\ir ../helpers/_setup.psql
select plan(8);
select tests.create_world();

select throws_ok($$ select api.org_purge_targets(tests.id('org_a')) $$, 'P0001', 'not_found', 'a live org is not a purge target');
select tests.act_as('owner');
select throws_ok($$ select api.org_purge_targets(tests.id('org_a')) $$, '42501', null, 'AC2: a user JWT cannot call it');
select throws_ok($$ select api.mark_org_purged_externally(tests.id('org_a')) $$, '42501', null, 'nor mark an org purged');

select tests.as_postgres();
update app.organizations set status = 'pending_deletion', deletion_requested_at = now(),
  deletion_scheduled_for = now() + interval '1 day' where id = tests.id('org_a');
select tests.as_service();
select throws_ok($$ select api.org_purge_targets(tests.id('org_a')) $$, 'P0001', 'not_found', 'nothing before the deletion date');
select tests.as_postgres();
update app.organizations set deletion_scheduled_for = now() - interval '1 minute' where id = tests.id('org_a');
update app.devices set auth_user_id = tests.id('display') where id = tests.id('display_device');
select tests.as_service();
select ok(tests.id('display') = any (api.org_purge_targets(tests.id('org_a'))), 'AC1: the org''s device users are listed');
select throws_ok($$ select api.org_purge_targets(tests.id('org_b')) $$, 'P0001', 'not_found', 'AC3: org B is never a target');
select lives_ok($$ select api.mark_org_purged_externally(tests.id('org_a')) $$, 'the function reports back');
select tests.as_postgres();
select isnt((select external_purged_at from app.organizations where id = tests.id('org_a')), null, 'the org is marked');

select * from finish();
rollback;
