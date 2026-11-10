-- #1136: the visit lookup follows the grant's life: it stops at expiry and on revoke, is bound to
-- the grantee for break-glass, never opens for a member, and is read-only. Support's own actions
-- show on the timeline, and local-day search works across the UTC date line.
begin;
\ir ../helpers/_setup.psql
select plan(26);
select tests.create_world();

select tests.create_user('support');
insert into app.platform_roles (user_id, role) values (tests.id('support'), 'support');
select tests.create_user('support2');
insert into app.platform_roles (user_id, role) values (tests.id('support2'), 'support');
create function tests.as_support() returns void
language sql as $$ select tests.as_user(tests.id('support'), jsonb_build_object('aal', 'aal2')) $$;
create function tests.as_support2() returns void
language sql as $$ select tests.as_user(tests.id('support2'), jsonb_build_object('aal', 'aal2')) $$;
create function tests.as_operator() returns void
language sql as $$ select tests.as_user(tests.id('platform'), jsonb_build_object('aal', 'aal2')) $$;
grant execute on function tests.as_support(), tests.as_support2(), tests.as_operator() to authenticated;

select tests.new_visit('visit_t', 'queue_a');

-- A read grant, then an act grant replaces it: the timeline reports the grant in force.
select tests.act_as('owner');
create temp table g1 as select * from api.grant_support_access(tests.id('org_a'), 'read', 2, 'first');
grant select on g1 to authenticated;
select tests.as_support();
select is((select (api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_t'))).support_grant ->> 'scope'),
  'read', 'a read grant is reported as read');
select tests.act_as('owner');
create temp table g2 as select * from api.grant_support_access(tests.id('org_a'), 'act', 2, 'second');
grant select on g2 to authenticated;
select tests.as_support();
select is((select (api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_t'))).support_grant ->> 'id'),
  (select id::text from g2), 'a replacement grant is the one reported');

-- Support's own action shows on the timeline, then the staff undo.
select api.transition_visit(tests.id('visit_t'), 'call', 0, gen_random_uuid());
select tests.act_as('staff');
select api.undo_event((select id from app.visit_events where visit_id = tests.id('visit_t') and type = 'call'), gen_random_uuid());
select tests.as_support();
create temp table tl as select * from api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_t'));
grant select on tl to authenticated;
select is((select jsonb_array_length(events) from tl), 3, 'join, call and undo are all on the timeline');
select is((select array_agg(e ->> 'type' order by (e ->> 'id')::bigint) from tl, jsonb_array_elements(events) e),
  array['joined', 'call', 'undo'], 'events are oldest first');
select is((select e ->> 'actor_kind' from tl, jsonb_array_elements(events) e where e ->> 'type' = 'call'),
  'platform', 'a support action is shown as platform');
select is((select e ->> 'via_support' from tl, jsonb_array_elements(events) e where e ->> 'type' = 'call'),
  'true', 'and marked as made through a grant');
select is((select e ->> 'undone' from tl, jsonb_array_elements(events) e where e ->> 'type' = 'call'),
  'true', 'the undone call is marked undone');
select is((select e ->> 'undoes_type' from tl, jsonb_array_elements(events) e where e ->> 'type' = 'undo'),
  'call', 'the undo says what it reversed');
select is((select e ->> 'actor_kind' from tl, jsonb_array_elements(events) e where e ->> 'type' = 'undo'),
  'staff', 'the undo was made by staff');
select is((select status::text from tl), 'waiting', 'the visit is back to waiting');

-- Looking changes nothing.
select tests.as_postgres();
create temp table before_look as
  select (select count(*) from app.visit_events) as events, (select sum(version) from app.visits) as versions;
select tests.as_support();
select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_t'));
select count(*) from api.platform_search_visits(tests.id('org_a'));
select tests.as_postgres();
select results_eq($$ select (select count(*) from app.visit_events), (select sum(version) from app.visits) $$,
  $$ select events, versions from before_look $$, 'looking up a visit writes no event and bumps no version');

-- A platform user who is also a member of the org is denied: they use the staff path.
insert into app.memberships (org_id, user_id, role) values (tests.id('org_a'), tests.id('support2'), 'staff');
select tests.as_support2();
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_t')) $$,
  '42501', 'permission_denied', 'a member of the org is not served through the support path');
select tests.as_postgres();
delete from app.memberships where user_id = tests.id('support2');

-- A suspended org is still readable under a grant.
update app.organizations set status = 'suspended' where id = tests.id('org_a');
select tests.as_support();
select lives_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_t')) $$,
  'a suspended org''s visit is readable under a grant');
select tests.as_postgres();
update app.organizations set status = 'active' where id = tests.id('org_a');

-- Expiry: one minute after, both calls behave as if there were no grant.
update app.support_grants set created_at = now() - interval '2 hours 1 minute',
                              expires_at = now() - interval '1 minute' where id = (select id from g2);
select tests.as_support();
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_t')) $$,
  '42501', 'permission_denied', 'an expired grant denies the timeline');
select throws_ok($$ select * from api.platform_search_visits(tests.id('org_a')) $$,
  '42501', 'permission_denied', 'an expired grant denies search');

-- Revoke ends access at once.
select tests.act_as('owner');
create temp table g3 as select * from api.grant_support_access(tests.id('org_a'), 'read', 1, 'third');
select tests.as_support();
select lives_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_t')) $$,
  'a fresh grant works');
select tests.act_as('owner');
select api.revoke_support_access(tests.id('org_a'));
select tests.as_support();
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_t')) $$,
  '42501', 'permission_denied', 'a revoked grant denies the timeline');
select throws_ok($$ select * from api.platform_search_visits(tests.id('org_a')) $$,
  '42501', 'permission_denied', 'a revoked grant denies search');

-- Break-glass: the operator who opened it, for one hour, read-only, visible to the owner.
select tests.as_operator();
create temp table bg as select * from api.platform_break_glass(tests.id('org_a'), 'Legal request 7');
select is((select (api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_t'))).support_grant ->> 'break_glass'),
  'true', 'break-glass opens the timeline for the operator and says so');
select tests.as_postgres();
select is((select reason from app.platform_audit where action = 'support.visit_timeline'
           and (target ->> 'support_grant_id')::uuid = (select id from bg)), 'Legal request 7',
  'the break-glass lookup is audited with its reason');
select tests.as_support2();
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_t')) $$,
  '42501', 'permission_denied', 'break-glass opens nothing for other support users');
select tests.act_as('owner');
select api.revoke_support_access(tests.id('org_a'));
select tests.as_operator();
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_t')) $$,
  '42501', 'permission_denied', 'the owner can end break-glass access');

-- Time zones: a visit that joined at 22:30 on 1 March in New York is 03:30 UTC on 2 March.
select tests.as_postgres();
select tests.new_visit('visit_tz', 'queue_a');
select private.set_actor('system', null);
update app.visits set joined_at = '2026-03-02 03:30:00+00', service_day = '2026-03-01'
where id = tests.id('visit_tz');
select tests.act_as('owner');
select api.grant_support_access(tests.id('org_a'), 'read', 1, 'tz');
select tests.as_support();
select is((select count(*) from api.platform_search_visits(tests.id('org_a'), p_service_day => date '2026-03-01')), 1::bigint,
  'search by the local service day finds the late-evening visit');
select is((select count(*) from api.platform_search_visits(tests.id('org_a'), p_service_day => date '2026-03-02')), 0::bigint,
  'the UTC date is not the service day');
select is((select tz from api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_tz'))), 'America/New_York',
  'the timeline gives the zone to render local time');
select is((select joined_at from api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_tz'))),
  timestamptz '2026-03-02 03:30:00+00', 'the instant is returned unchanged');

select * from finish();
rollback;
