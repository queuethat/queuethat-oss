-- 2P-RPT4 (#200): api.begin_data_export.
begin;
\ir ../helpers/_setup.psql
select plan(20);
select tests.create_world();

create table tests.subs as select name, (claims ->> 'sub')::uuid as sub from tests.actors;
grant select on tests.subs to authenticated, anon;
create function tests.as_aal(p_actor text, p_aal text) returns void language sql as $$
  select tests.as_user((select sub from tests.subs where name = p_actor), jsonb_build_object('aal', p_aal))
$$;
grant execute on function tests.as_aal(text, text) to authenticated;
-- The fixture ticket is old; remove it so the day's count starts at zero.
delete from app.data_exports;

-- AC: owner and admin start an export; the ticket says how many are left.
select tests.act_as('owner');
select is((select (api.begin_data_export('csv', '00000000-0000-4000-8000-000000000001')).remaining_today), 2,
  'an owner starts a CSV export with 2 left today');
select is((select (api.begin_data_export('csv', '00000000-0000-4000-8000-000000000001')).export_id),
  (select id from app.data_exports where idempotency_key = '00000000-0000-4000-8000-000000000001'),
  'repeating the key returns the same ticket');
select tests.act_as('admin');
select is((select (api.begin_data_export('jsonl', '00000000-0000-4000-8000-000000000002')).format), 'jsonl',
  'an org-wide admin starts a JSON Lines export');

-- AC2: the 4th export in a day is refused; a replay of an earlier key is not.
select lives_ok($$ select api.begin_data_export('csv', '00000000-0000-4000-8000-000000000003') $$, 'the third works');
select throws_ok($$ select api.begin_data_export('csv', '00000000-0000-4000-8000-000000000004') $$, 'P0001', 'rate_limited',
  'AC2: the fourth in a day is rate_limited');
select lives_ok($$ select api.begin_data_export('csv', '00000000-0000-4000-8000-000000000003') $$,
  'replaying an earlier key still works at the limit');
select tests.as_postgres();
select is((select count(*)::int from app.audit_log where action = 'EXPORT' and table_name = 'data_exports' and org_id = tests.id('org_a')), 3,
  'AC4: three exports wrote three audit rows (the replays wrote none)');
select is((select role from app.audit_log where action = 'EXPORT' and table_name = 'data_exports' order by id limit 1), 'owner', 'AC4: the audit row records the role');
select is((select after ->> 'format' from app.audit_log where action = 'EXPORT' and table_name = 'data_exports' order by id limit 1), 'csv', 'AC4: and the format');
select ok((select actor is not null and at is not null from app.audit_log where action = 'EXPORT' and table_name = 'data_exports' order by id limit 1), 'AC4: and actor and time');
update app.data_exports set created_at = now() - interval '25 hours';
select tests.act_as('admin');
select is((select (api.begin_data_export('csv', '00000000-0000-4000-8000-000000000005')).remaining_today), 2,
  'exports older than 24 hours no longer count');

-- AC3: everyone else is denied.
select tests.act_as('manager');
select throws_ok($$ select api.begin_data_export('csv', gen_random_uuid()) $$, '42501', null, 'AC3: a manager is denied');
select tests.act_as('staff');
select throws_ok($$ select api.begin_data_export('csv', gen_random_uuid()) $$, '42501', null, 'AC3: staff are denied');
select tests.act_as('display');
select throws_ok($$ select api.begin_data_export('csv', gen_random_uuid()) $$, '42501', null, 'AC3: a display is denied');
select tests.act_as('kiosk');
select throws_ok($$ select api.begin_data_export('csv', gen_random_uuid()) $$, '42501', null, 'AC3: a kiosk is denied');
select tests.as_anon();
select throws_ok($$ select api.begin_data_export('csv', gen_random_uuid()) $$, '42501', null, 'anon cannot execute it');

-- MFA: an org that requires it needs aal2 to export.
select tests.as_postgres();
update app.organizations set require_mfa_for_admins = true where id = tests.id('org_a');
select tests.as_aal('owner', 'aal1');
select throws_ok($$ select api.begin_data_export('csv', gen_random_uuid()) $$, 'P0001', 'mfa_required',
  'an owner at aal1 gets mfa_required when the org requires MFA');
select tests.as_aal('owner', 'aal2');
select lives_ok($$ select api.begin_data_export('csv', gen_random_uuid()) $$, 'and the same owner at aal2 exports');

-- Cross-tenant: org B's owner exports org B, and cannot read org A's tickets.
select tests.act_as('other_owner');
select lives_ok($$ select api.begin_data_export('csv', '00000000-0000-4000-8000-0000000000b1') $$, 'org B owner exports their own org');
select is((select count(*)::int from app.data_exports where org_id = tests.id('org_a')), 0, 'and sees none of org A''s tickets');

select * from finish();
rollback;
