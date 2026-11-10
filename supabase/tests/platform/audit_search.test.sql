-- #1133: global platform audit search and export. Operators search every row; support see only
-- their own; both need aal2; contact data is masked in what the API returns; the export is itself
-- audited and capped; the table stays append-only.
begin;
\ir ../helpers/_setup.psql
select plan(111);

select tests.create_world();
select tests.create_user('support');
select tests.create_user('support2');
insert into app.platform_roles (user_id, role) values
  (tests.id('support'), 'support'), (tests.id('support2'), 'support');
create function tests.as_support(p_aal text default 'aal2') returns void
language sql as $$ select tests.as_user(tests.id('support'), jsonb_build_object('aal', p_aal)) $$;
create function tests.as_support2() returns void
language sql as $$ select tests.as_user(tests.id('support2'), jsonb_build_object('aal', 'aal2')) $$;
create function tests.as_operator(p_aal text default 'aal2') returns void
language sql as $$ select tests.as_user(tests.id('platform'), jsonb_build_object('aal', p_aal)) $$;
grant execute on function tests.as_support(text), tests.as_support2(), tests.as_operator(text) to authenticated;

-- Fixture rows (written as postgres, the way definer functions would).
select tests.as_postgres();
insert into app.platform_audit (actor_id, action, org_id, target, reason, at) values
  (tests.id('platform'), 'org.suspend', tests.id('org_a'),
   '{"from":"active","to":"suspended"}', 'Abuse report', '2026-10-01 12:00:00+00'),
  (tests.id('platform'), 'org.unsuspend', tests.id('org_a'),
   '{"from":"suspended","to":"active"}', 'Resolved', '2026-10-02 12:00:00+00'),
  (tests.id('support'), 'entitlement.set', tests.id('org_a'),
   '{"key":"sms","value":true}', 'Trial extension', '2026-10-03 12:00:00+00'),
  (tests.id('support2'), 'entitlement.clear', tests.id('org_b'),
   '{"key":"sms"}', null, '2026-10-04 12:00:00+00'),
  -- Contact data in every shape a payload can carry it.
  (tests.id('platform'), 'org.transfer_ownership', tests.id('org_b'),
   jsonb_build_object('new_owner', tests.id('owner'), 'new_owner_email', 'boss@secret.test',
     'previous_owners', jsonb_build_array(tests.id('other_owner')),
     'nested', jsonb_build_object('note', 'mail ann@private.test now', 'phone', '+12045550100'),
     'contacts', jsonb_build_array(jsonb_build_object('email', 'x@y.test'), 'plain'),
     'free', '+1 204 555 0199', 'date', '2026-10-05', 'count', 3),
   'Owner asked: write to boss@secret.test or +1 204 555 0123', '2026-10-05 12:00:00+00'),
  -- A service-role action (no actor), an actor whose account is gone, an org that is gone.
  (null, 'platform_role.grant', null, '{"role":"support"}', null, '2026-10-06 12:00:00+00'),
  ('00000000-0000-0000-0000-00000000dead', 'org.suspend',
   '00000000-0000-0000-0000-00000000beef', '{}', 'Ghost', '2026-10-07 12:00:00+00'),
  -- break-glass whose grant row is gone: the reason still shows.
  (tests.id('platform'), 'support.break_glass', tests.id('org_b'),
   '{"support_grant_id":"00000000-0000-0000-0000-0000000000aa"}', 'Orphan grant reason', '2026-10-08 12:00:00+00'),
  -- Hostile text: CSV quoting and spreadsheet formulas.
  (tests.id('platform'), 'org.suspend', tests.id('loc_a'),
   '{}', E'say "hi", ok\nnext', '2026-10-09 12:00:00+00'),
  (tests.id('platform'), 'org.suspend', tests.id('loc_a'),
   '{}', '=HYPERLINK("http://evil.test")', '2026-10-09 13:00:00+00'),
  (tests.id('platform'), 'org.suspend', tests.id('loc_a'),
   '{"support_grant_id":"not-a-uuid"}', '+cmd', '2026-10-09 14:00:00+00');

-- A real break-glass, so the grant id and its reason come from the live grant.
select tests.as_operator();
create temp table bg as select * from api.platform_break_glass(tests.id('org_a'), 'Customer locked out, call 204-555-0100');
grant select on bg to authenticated;

------------------------------------------------------------------------------------------------
-- Access: role ladder, MFA, anon
------------------------------------------------------------------------------------------------
select tests.as_anon();
select throws_ok($$ select * from api.platform_audit_search() $$, '42501', null, 'anon cannot search');
select throws_ok($$ select * from api.platform_audit_export() $$, '42501', null, 'anon cannot export');
select tests.act_as('owner');
select throws_ok($$ select * from api.platform_audit_search() $$, '42501', null,
  'a tenant owner cannot search the platform audit');
select throws_ok($$ select * from api.platform_audit_export() $$, '42501', null,
  'a tenant owner cannot export the platform audit');
select tests.as_operator('aal1');
select throws_ok($$ select * from api.platform_audit_search() $$, '42501', 'permission_denied',
  'an operator without MFA cannot search');
select throws_ok($$ select * from api.platform_audit_export() $$, '42501', 'permission_denied',
  'an operator without MFA cannot export');
select tests.as_support('aal1');
select throws_ok($$ select * from api.platform_audit_search() $$, '42501', 'permission_denied',
  'support without MFA cannot search');
select throws_ok($$ select * from api.platform_audit_export() $$, '42501', 'permission_denied',
  'support without MFA cannot export');

------------------------------------------------------------------------------------------------
-- Operator: everything, newest first
------------------------------------------------------------------------------------------------
select tests.as_operator();
select is((select count(*) from api.platform_audit_search(p_org_id => tests.id('org_a'))), 4::bigint,
  'an operator sees every actor''s rows for org A (3 fixtures + break-glass)');
select is(
  array(select action from api.platform_audit_search(p_org_id => tests.id('org_a'))),
  array['support.break_glass', 'entitlement.set', 'org.unsuspend', 'org.suspend'],
  'newest first');
select is(
  array(select action from api.platform_audit_search(p_actor => tests.id('support'))),
  array['entitlement.set'], 'filter by actor');
select is(
  array(select action from api.platform_audit_search(p_org_id => tests.id('org_b'), p_action => 'entitlement.clear')),
  array['entitlement.clear'], 'action filter is exact');
select is((select count(*) from api.platform_audit_search(p_action => 'org.')), 7::bigint,
  'an action ending in a dot matches the whole family');
select is((select count(*) from api.platform_audit_search(p_action => 'org')), 0::bigint,
  'a partial word without the trailing dot matches nothing');
select is((select count(*) from api.platform_audit_search(p_action => 'org._uspend')), 0::bigint,
  'LIKE wildcards in the action filter are literal');
select is((select count(*) from api.platform_audit_search(p_action => '  ')), (select count(*) from app.platform_audit),
  'a blank action filter means no filter');
select is((select count(*) from api.platform_audit_search(p_actor => tests.id('platform'), p_org_id => tests.id('org_a'),
  p_action => 'org.suspend')), 1::bigint, 'filters combine with AND');
select is((select count(*) from api.platform_audit_search(p_org_id => gen_random_uuid())), 0::bigint,
  'an unknown org is an empty result, not an error');
select is((select count(*) from api.platform_audit_search(p_actor => tests.id('owner'))), 0::bigint,
  'an actor with no rows gives an empty result');
select is((select count(*) from api.platform_audit_search(p_actor => tests.id('platform'), p_action => 'nope.nope')),
  0::bigint, 'no match is empty');
select is((select count(*) from api.platform_audit_search(p_actor => '00000000-0000-0000-0000-00000000dead')), 1::bigint,
  'rows by a deleted account are still searchable by its id');
select is((select actor_email from api.platform_audit_search(p_actor => '00000000-0000-0000-0000-00000000dead')), null,
  'a deleted account has no email');
select is((select count(*) from api.platform_audit_search(p_action => 'platform_role.grant', p_to => '2026-10-06 13:00+00')
  where actor_id is null and actor_email is null), 1::bigint, 'a service-role row (no actor) is returned');
select is((select org_name from api.platform_audit_search(p_org_id => '00000000-0000-0000-0000-00000000beef')), null,
  'a row about a deleted org has no org name but is returned');
select is((select org_name from api.platform_audit_search(p_org_id => tests.id('org_a'), p_action => 'org.suspend')),
  'Org A', 'org name is joined');
select ok((select actor_email like '%@%' from api.platform_audit_search(p_actor => tests.id('support'))),
  'actor email is joined');

------------------------------------------------------------------------------------------------
-- Date range and timezones: from inclusive, to exclusive, instants not dates
------------------------------------------------------------------------------------------------
select is(array(select action from api.platform_audit_search(p_org_id => tests.id('org_a'),
    p_from => '2026-10-01 12:00+00', p_to => '2026-10-02 12:00+00')),
  array['org.suspend'], 'from is inclusive and to is exclusive');
select is((select count(*) from api.platform_audit_search(p_org_id => tests.id('org_a'),
    p_from => '2026-10-01 12:00:00.000001+00', p_to => '2026-10-02 12:00:00.000001+00')), 1::bigint,
  'microsecond boundaries hold');
select is((select count(*) from api.platform_audit_search(p_org_id => tests.id('org_a'),
    p_from => '2026-10-02 12:00+00', p_to => '2026-10-02 12:00+00')), 0::bigint, 'from = to is empty');
select throws_ok($$ select * from api.platform_audit_search(p_from => '2026-10-03+00', p_to => '2026-10-02+00') $$,
  'P0001', 'invalid_input', 'from after to is invalid_input');
select is(
  array(select id from api.platform_audit_search(p_org_id => tests.id('org_a'), p_from => '2026-10-02 12:00+00', p_to => '2026-10-04+00')),
  array(select id from api.platform_audit_search(p_org_id => tests.id('org_a'), p_from => '2026-10-02 07:00-05', p_to => '2026-10-03 19:00-05')),
  'the same instants in other UTC offsets select the same rows');
-- A Winnipeg (CST, UTC-6 in October after DST ends Nov 1; CDT UTC-5 before) local day.
select is(array(select action from api.platform_audit_search(p_org_id => tests.id('org_a'),
    p_from => '2026-10-02 00:00:00-05', p_to => '2026-10-03 00:00:00-05')),
  array['org.unsuspend'], 'a local calendar day, expressed in its own offset, selects that day''s rows');
select is((select count(*) from api.platform_audit_search(p_org_id => tests.id('org_a'), p_from => '2026-10-02 12:00:01+00', p_to => '2026-10-03 11:59:59+00')),
  0::bigint, 'an open window between two rows is empty');
select is(array(select action from api.platform_audit_search(p_org_id => tests.id('org_a'), p_from => '2026-10-02 12:00+00', p_to => null)),
  array['support.break_glass', 'entitlement.set', 'org.unsuspend'], 'an open-ended range works');

------------------------------------------------------------------------------------------------
-- Limits and pagination
------------------------------------------------------------------------------------------------
select throws_ok($$ select * from api.platform_audit_search(p_limit => 0) $$, 'P0001', 'invalid_input', 'limit 0 is invalid');
select throws_ok($$ select * from api.platform_audit_search(p_limit => 201) $$, 'P0001', 'invalid_input', 'limit 201 is invalid');
select throws_ok($$ select * from api.platform_audit_search(p_limit => null) $$, 'P0001', 'invalid_input', 'a null limit is invalid');
select lives_ok($$ select * from api.platform_audit_search(p_limit => 200) $$, 'limit 200 is accepted');
select lives_ok($$ select * from api.platform_audit_search(p_limit => 1) $$, 'limit 1 is accepted');

select tests.as_postgres();
insert into app.platform_audit (actor_id, action, org_id, at)
select tests.id('platform'), 'zt.page', tests.id('loc_b'), '2026-11-01 00:00+00' from generate_series(1, 5);
select tests.as_operator();

select is(array_length(array(select id from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 2)), 1), 2,
  'page 1 of 5 rows at limit 2 has 2 rows');
select is(array(select id from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 2, p_after =>
    (select min(id) from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 2)))) <@
  array(select id from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 5)), true,
  'page 2 stays inside the full set');
select is(
  array(select id from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 2))
  || array(select id from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 2, p_after =>
      (select min(id) from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 2))))
  || array(select id from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 2, p_after =>
      (select min(id) from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 2, p_after =>
        (select min(id) from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 2)))))),
  array(select id from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 200)),
  'pages of 2, 2 and 1 add up to the full set, in order, with no gaps or repeats');
select is((select count(*) from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 5)), 5::bigint,
  'a page that exactly fits the remaining rows returns them all');
select is((select count(*) from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 5,
    p_after => (select min(id) from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 5)))), 0::bigint,
  'the page after the last row is empty');
select is((select count(*) from api.platform_audit_search(p_limit => 50, p_after => 0)), 0::bigint,
  'after = 0 is empty (ids start at 1 and the cursor is exclusive)');
select is((select count(*) from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 200,
    p_after => (select max(id) + 1000 from app.platform_audit))), 5::bigint,
  'a cursor past the newest id returns everything');

-- A row written between two page requests does not shift page 2.
create temp table before_page2 as
  select id from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 2, p_after =>
    (select min(id) from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 2)));
select tests.as_postgres();
insert into app.platform_audit (actor_id, action, org_id, at)
values (tests.id('platform'), 'zt.page', tests.id('loc_b'), '2026-11-01 00:00+00');
select tests.as_operator();
select is(
  array(select id from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 2, p_after =>
    (select min(id) from (select id from api.platform_audit_search(p_org_id => tests.id('loc_b'), p_limit => 3) order by id desc offset 1 limit 2) s))),
  array(select id from before_page2 order by id desc),
  'a concurrent insert does not shift the next page (keyset, not offset)');

------------------------------------------------------------------------------------------------
-- Support sees only their own rows
------------------------------------------------------------------------------------------------
select tests.as_support();
select is((select count(*) from api.platform_audit_search(p_limit => 200) where actor_id is distinct from tests.id('support')),
  0::bigint, 'support see no other actor''s rows');
select is(array(select action from api.platform_audit_search()), array['entitlement.set'], 'support see their own row');
select is((select count(*) from api.platform_audit_search(p_actor => tests.id('platform'))), 0::bigint,
  'support filtering by an operator get nothing, not an error');
select is((select count(*) from api.platform_audit_search(p_actor => tests.id('support'))), 1::bigint,
  'support filtering by themselves works');
select is((select count(*) from api.platform_audit_search(p_org_id => tests.id('org_b'))), 0::bigint,
  'support see none of another actor''s rows for an org');
select is((select count(*) from api.platform_audit_search(p_action => 'org.')), 0::bigint,
  'support see no operator actions by action family');
select tests.as_support2();
select is(array(select action from api.platform_audit_search()), array['entitlement.clear'],
  'a second support user sees only their own row');

------------------------------------------------------------------------------------------------
-- Masking
------------------------------------------------------------------------------------------------
select tests.as_operator();
create temp table masked as
  select * from api.platform_audit_search(p_action => 'org.transfer_ownership');
grant select on masked to authenticated;
select is((select count(*) from masked), 1::bigint, 'the contact-bearing row is returned');
select is((select target ->> 'new_owner_email' from masked), '[masked]', 'a contact key is masked');
select is((select target #>> '{nested,phone}' from masked), '[masked]', 'a nested contact key is masked');
select is((select target #>> '{nested,note}' from masked), 'mail ***@private.test now',
  'an email inside free text is masked, the rest kept');
select is((select target -> 'contacts' from masked), '"[masked]"'::jsonb,
  'everything under a contact key is masked, arrays included');
select is((select target ->> 'free' from masked), '[masked]', 'a bare +phone value is masked whatever its key');
select is((select reason from masked), 'Owner asked: write to ***@secret.test or [masked]',
  'the reason column is masked too');
select is((select (target ->> 'new_owner')::uuid from masked), tests.id('owner'), 'ids are not masked');
select is((select target ->> 'date' from masked), '2026-10-05', 'a date is not mistaken for a phone');
select is((select target -> 'count' from masked), '3'::jsonb, 'numbers are kept');
select is((select count(*) from api.platform_audit_search(p_limit => 200)
  where target::text ~ '(boss@|ann@|x@y|204 555|2045550|204-555)' or reason ~ '(boss@|204 555|204-555)'), 0::bigint, 'no search result carries a raw contact');
select tests.as_postgres();
select is((select target ->> 'new_owner_email' from app.platform_audit where action = 'org.transfer_ownership'),
  'boss@secret.test', 'the stored row is untouched; masking is display-only');
select is(private.mask_audit_json(null), '{}'::jsonb, 'masking a null payload gives an empty object');
select is(private.mask_audit_json('"a@b.test"'), '"***@b.test"'::jsonb, 'masking a bare string');
select is(private.mask_audit_json('[1,"c@d.test",{"phone":null}]'), '[1,"***@d.test",{"phone":null}]'::jsonb,
  'arrays recurse, and a null under a contact key stays null');

------------------------------------------------------------------------------------------------
-- Support grant id and break-glass reason
------------------------------------------------------------------------------------------------
select tests.as_operator();
select is((select support_grant_id from api.platform_audit_search(p_action => 'support.break_glass', p_org_id => tests.id('org_a'))),
  (select id from bg), 'the support grant id is shown');
select is((select break_glass_reason from api.platform_audit_search(p_action => 'support.break_glass', p_org_id => tests.id('org_a'))),
  'Customer locked out, call [masked]', 'the break-glass reason is shown (contact masked)');
select is((select break_glass_reason from api.platform_audit_search(p_action => 'support.break_glass', p_org_id => tests.id('org_b'))),
  'Orphan grant reason', 'when the grant row is gone the audit reason still shows');
select is((select support_grant_id from api.platform_audit_search(p_action => 'org.suspend', p_org_id => tests.id('loc_a')) limit 1), null,
  'a malformed grant id in a payload is ignored, not an error');
select is((select count(*) from api.platform_audit_search(p_action => 'org.suspend') where support_grant_id is not null), 0::bigint,
  'rows without a grant have no grant id');

------------------------------------------------------------------------------------------------
-- Export
------------------------------------------------------------------------------------------------
select tests.as_operator();
create temp table ex1 as select * from api.platform_audit_export(p_org_id => tests.id('org_a'));
grant select on ex1 to authenticated;
select is((select row_count from ex1), 4, 'export row_count');
select is((select truncated from ex1), false, 'a small export is not truncated');
select is((select next_after from ex1), null, 'a complete export has no next_after');
select is((select split_part(csv, E'\r\n', 1) from ex1),
  'id,at,actor_id,actor_email,action,org_id,org_name,reason,support_grant_id,break_glass_reason,target',
  'the CSV starts with the header');
select is((select array_length(string_to_array(csv, E'\r\n'), 1) from ex1), 5, 'one header line plus one per row');
select ok((select csv ~ '"2026-10-03T12:00:00\.000000Z"' from ex1), 'timestamps are UTC ISO 8601');
select ok((select csv not like '%boss@%' and csv not like '%204-555%' from ex1), 'the export is masked like the search');
select is((select count(*) from api.platform_audit_search(p_action => 'audit.export')), 1::bigint,
  'the export is itself audited');
select is((select target ->> 'row_count' from api.platform_audit_search(p_action => 'audit.export')), '4',
  'the audit row records the row count');
select is((select org_id from api.platform_audit_search(p_action => 'audit.export')), tests.id('org_a'),
  'the audit row names the org that was exported');
select is((select actor_id from api.platform_audit_search(p_action => 'audit.export')), tests.id('platform'),
  'the audit row names the exporter');
select is((select target ->> 'truncated' from api.platform_audit_search(p_action => 'audit.export')), 'false',
  'the audit row records truncation');
create temp table ex2 as select * from api.platform_audit_export(p_org_id => tests.id('org_a'));
grant select on ex2 to authenticated;
select is((select row_count from ex2), 5, 'a second export includes the first export''s audit row');

-- Empty range.
create temp table ex3 as select * from api.platform_audit_export(p_org_id => gen_random_uuid());
grant select on ex3 to authenticated;
select is((select csv from ex3), 'id,at,actor_id,actor_email,action,org_id,org_name,reason,support_grant_id,break_glass_reason,target',
  'an empty export is the header alone');
select is((select row_count from ex3), 0, 'an empty export reports zero rows');
select is((select count(*) from api.platform_audit_search(p_action => 'audit.export')), 3::bigint,
  'an empty export is still audited');

-- Hostile text.
create temp table ex4 as select * from api.platform_audit_export(p_org_id => tests.id('loc_a'));
grant select on ex4 to authenticated;
select ok((select csv like E'%"say ""hi"", ok\nnext"%' from ex4), 'quotes and newlines are escaped');
select ok((select csv like '%"''=HYPERLINK(""http://evil.test"")"%' from ex4), 'a formula is neutralised with a leading quote');
select ok((select csv like '%"''+cmd"%' from ex4), 'a leading + is neutralised too');

-- Bad input raises and audits nothing.
select throws_ok($$ select * from api.platform_audit_export(p_from => '2026-10-03+00', p_to => '2026-10-02+00') $$,
  'P0001', 'invalid_input', 'an inverted range is refused');
select tests.as_postgres();
select is((select count(*) from app.platform_audit where action = 'audit.export'), 4::bigint,
  'a refused export is not audited');

-- Large export: capped at 10,000 rows, continued with next_after.
insert into app.platform_audit (actor_id, action, org_id, at)
select tests.id('platform'), 'zt.bulk', tests.id('kiosk'), '2026-11-01 00:00+00' from generate_series(1, 10005);
select tests.as_operator();
create temp table big1 as select * from api.platform_audit_export(p_org_id => tests.id('kiosk'));
grant select on big1 to authenticated;
select is((select row_count from big1), 10000, 'an export is capped at 10,000 rows');
select is((select truncated from big1), true, 'a capped export says so');
select isnt((select next_after from big1), null, 'a capped export returns where to continue');
select is((select array_length(string_to_array(csv, E'\r\n'), 1) from big1), 10001, 'the capped CSV has 10,000 rows plus the header');
create temp table big2 as select * from api.platform_audit_export(p_org_id => tests.id('kiosk'), p_after => (select next_after from big1));
grant select on big2 to authenticated;
select is((select row_count from big2), 5, 'the continuation has the rest');
select is((select truncated from big2), false, 'the last part is not truncated');
select is((select count(*) from api.platform_audit_search(p_action => 'audit.export', p_org_id => tests.id('kiosk'))), 2::bigint,
  'each part is audited');
create temp table exact as
  select * from api.platform_audit_export(p_org_id => tests.id('kiosk'), p_action => 'zt.bulk', p_after => (select next_after from big1) + 1);
grant select on exact to authenticated;
select is((select truncated from exact), false, 'a part that fits is not truncated');

-- Support export is limited to their own rows and audited under their name.
select tests.as_support();
create temp table sx as select * from api.platform_audit_export();
grant select on sx to authenticated;
select is((select row_count from sx), 1, 'support export only their own rows');
select ok((select csv not like '%org.suspend%' from sx), 'support export carries no operator row');
select is((select target ->> 'scope' from api.platform_audit_search(p_action => 'audit.export')), 'own',
  'the audit row records that the export was limited to the caller''s rows');

-- Append-only still holds, and reading never writes.
select tests.as_postgres();
select throws_ok($$ update app.platform_audit set reason = 'x' $$, '42501', 'platform_audit is append-only', 'update still refused');
select throws_ok($$ delete from app.platform_audit $$, '42501', 'platform_audit is append-only', 'delete still refused');
select throws_ok($$ truncate app.platform_audit $$, '42501', 'platform_audit is append-only', 'truncate still refused');
create temp table n0 as select count(*) c from app.platform_audit;
select tests.as_operator();
select ok(count(*) >= 0, 'a search runs') from api.platform_audit_search(p_limit => 200);
select tests.as_postgres();
select is((select count(*) from app.platform_audit), (select c from n0), 'searching writes no audit row');

select * from finish();
rollback;
