-- The open-source build has no hosted-operator console and no billing (migration
-- 20261110171733_drop_hosted_schema). Nothing of either is left in the schema, and the tenant
-- functions that used to consult them behave as if they had never been there.
begin;
\ir ../helpers/_setup.psql
select plan(19);
select tests.create_world();
select tests.create_user('stranger');

-- ------------------------------------------------------------------ nothing is left in the catalog
select is_empty(
  $$ select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any (tests.own_schemas()) and c.relkind in ('r', 'v', 'm', 'p', 'f', 'S')
       and c.relname ~ '^platform_' and c.relname <> 'platform_flags' $$,
  'no table, view or sequence is named platform_* except app.platform_flags');
select is_empty(
  $$ select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any (tests.own_schemas()) and c.relkind in ('r', 'v', 'm', 'p')
       and c.relname in ('plans', 'plan_entitlements', 'subscriptions', 'credit_ledger', 'credit_balance',
                         'billing_jobs', 'incident_notices') $$,
  'no plan, subscription, credit, billing-job or incident-notice relation exists');
select is_empty(
  $$ select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any (tests.own_schemas())
       and (p.proname like 'platform\_%' or p.proname like '%\_platform\_%' or p.proname like '%\_platform')
       and p.proname <> 'platform_sms_mode' $$,
  'no function is named for the platform console except private.platform_sms_mode');
select is_empty(
  $$ select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any (tests.own_schemas())
       and (p.proname ~ '(billing|credit|subscription|bundle_grant|org_plan|payment_grace|incident_notice|break_glass)'
            or p.proname in ('is_platform', 'require_support_grant', 'org_activation', 'incident_event', 'incident_row',
                             'notify_sms_paused', 'notify_sms_warning', 'forbid_incident_event_change')) $$,
  'no billing, credit, subscription, operator-role or incident-register function exists');
select is_empty(
  $$ select n.nspname || '.' || t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = any (tests.own_schemas()) and t.typname !~ '^_'
       and (t.typname ~ '^platform_' or t.typname in ('incident_status', 'incident_notice', 'announcement_severity'))
       and t.typname <> 'platform_flags' $$,
  'no platform_* or incident type exists (app.platform_flags is the table''s row type)');
select is_empty(
  $$ select a.attname from pg_attribute a
     where a.attrelid = 'app.platform_flags'::regclass and not a.attisdropped
       and a.attname in ('billing_enabled', 'sms_margin_bps', 'credit_low_micros', 'sms_bundle_grant_micros') $$,
  'app.platform_flags has no billing column');
select is_empty(
  $$ select jobname from cron.job
     where jobname in ('platform-stats-tick', 'kick-billing-jobs', 'payment-grace-reminders',
                       'pause-unhealthy-platform-sms', 'platform-sms-tick', 'platform-sms-digest')
        or jobname ~ '(billing|platform)' $$,
  'no billing or platform job is scheduled');
select is_empty(
  $$ select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any (tests.own_schemas()) and p.prokind = 'f'
       and p.prosrc ~ '(app\.platform_(?!flags)|private\.platform_(?!sms_mode)|api\.platform_|is_platform|require_platform|billing_enabled|credit_ledger|credit_balance|app\.subscriptions|app\.plans|plan_entitlements|billing_jobs|incident_notices|org_plan)' $$,
  'no remaining function body mentions a removed object');

-- ------------------------------------------------------------------ a support grant gives nobody access
insert into app.support_grants (org_id, granted_by, scope, reason, expires_at)
values (tests.id('org_b'), tests.id('other_owner'), 'act', 'live fixture grant', now() + interval '1 hour');
select is((select count(*)::int from app.support_grants where org_id = tests.id('org_b') and revoked_at is null and expires_at > now()), 1,
  'org B has a live, unrevoked act grant');
select is((select count(*)::int from private.support_grant(tests.id('org_b')) g where g.id is not null), 0,
  'private.support_grant returns no grant for it');
select tests.as_user(tests.id('stranger'), '{"aal":"aal2"}');
select is(private.has_role(tests.id('org_b'), null, 'staff'), false, 'private.has_role denies a signed-in non-member, even with aal2');
select tests.act_as('owner');
select is(private.has_role(tests.id('org_b'), null, 'staff'), false, 'and another org''s owner');
select tests.act_as('other_owner');
select is(private.has_role(tests.id('org_b'), null, 'owner'), true, 'while the org''s own owner still has their role');
select tests.as_postgres();

-- ------------------------------------------------------------------ no cross-business contact blocklist
select is(private.is_blocked(tests.id('org_a'), '+14155550100', 'someone@example.test'), false,
  'private.is_blocked is false for any phone and email');
select is(private.is_blocked(tests.id('org_a'), null, null), false, 'and for no contact at all');

-- ------------------------------------------------------------------ an incident report stays with the business
delete from app.guest_notices;
delete from app.org_incident_log;
select tests.act_as('owner');
select lives_ok($$ select api.report_incident(tests.id('org_a'), 'lost_device', 'Phone lost', p_notify_platform => true) $$,
  'an owner reports an incident and asks for the platform to be told');
select tests.as_postgres();
select results_eq($$ select source, org_id, title from app.org_incident_log $$,
  $$ values ('manual', tests.id('org_a'), 'Phone lost') $$,
  'it writes exactly one row to the business''s own log, with source manual');

-- ------------------------------------------------------------------ entitlements: override, else default
-- create_world: fixture.flag defaults to false; org A overrides it to true.
select is(private.entitlement(tests.id('org_a'), 'fixture.flag'), 'true'::jsonb, 'private.entitlement returns the org''s override when there is one');
select is(private.entitlement(tests.id('org_b'), 'fixture.flag'), 'false'::jsonb, 'and the default when there is none');

select * from finish();
rollback;
