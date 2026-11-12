-- Extension hooks, part 2: each hook does nothing here, and a deployment that replaces its body
-- changes the tenant function's behaviour at that one point.
begin;
\ir ../helpers/_setup.psql
select plan(18);
select tests.create_world();

-- ------------------------------------------------------------------ contract
select function_returns('private', 'ext_bills_shared_sms', array['uuid'], 'boolean', 'ext_bills_shared_sms(uuid) returns boolean');
select function_returns('private', 'ext_report_incident',
  array['uuid', 'text', 'text', 'text', 'timestamp with time zone', 'text[]', 'uuid'], 'uuid',
  'ext_report_incident(...) returns uuid');
select function_returns('private', 'ext_support_context', array['uuid'], 'jsonb', 'ext_support_context(uuid) returns jsonb');
select function_returns('private', 'ext_purge_keep_tables', array[]::text[], 'text[]', 'ext_purge_keep_tables() returns text[]');
select function_returns('private', 'ext_price_changed', array['uuid', 'uuid', 'bigint', 'bigint'], 'void',
  'ext_price_changed(uuid, uuid, bigint, bigint) returns void');

-- ------------------------------------------------------------------ platform SMS needs the deployment to bill it
update private.deployment_settings set platform_messaging_enabled = true;
select tests.act_as('owner');
select api.set_provider_settings(tests.id('org_a'), 'sms', 'twilio', 'platform', '{}', '{}', gen_random_uuid());
select tests.as_postgres();
select ok('platform_requires_billing' = any (private.channel_missing(tests.id('org_a'), 'sms')),
  'here platform SMS always lacks billing');
create or replace function private.ext_bills_shared_sms(p_org_id uuid) returns boolean
language sql stable set search_path = '' as $$ select p_org_id = tests.id('org_a') $$;
select ok(not ('platform_requires_billing' = any (private.channel_missing(tests.id('org_a'), 'sms'))),
  'a deployment that bills the org clears that prerequisite');

-- ------------------------------------------------------------------ incident reports
select tests.act_as('owner');
select api.report_incident(tests.id('org_a'), 'other', 'Plain', p_notify_platform => true) as plain_id \gset
select tests.as_postgres();
select is((select l.source from app.org_incident_log l where l.id = :'plain_id'), 'manual',
  'here a report to the platform is a plain log entry');
create table tests.hook_calls (title text, cats text[]);
grant all on tests.hook_calls to authenticated;
create or replace function private.ext_report_incident(p_org_id uuid, p_kind text, p_title text, p_description text,
  p_detected_at timestamptz, p_data_categories text[], p_idempotency_key uuid) returns uuid
language sql volatile set search_path = '' as $$
  insert into tests.hook_calls values (p_title, p_data_categories);
  select '33333333-3333-3333-3333-333333333333'::uuid
$$;
select tests.act_as('owner');
select is(api.report_incident(tests.id('org_a'), 'other', '  Hooked  ', null, null, '{a,a}', true),
  '33333333-3333-3333-3333-333333333333'::uuid, 'a deployment hook takes the report and its id is returned');
select api.report_incident(tests.id('org_a'), 'other', 'Local only', p_notify_platform => false) as local_id \gset
select tests.as_postgres();
select is((select l.source from app.org_incident_log l where l.id = :'local_id'), 'manual',
  'p_notify_platform false never reaches the hook');
select results_eq($$ select title, cats from tests.hook_calls $$, $$ values ('Hooked', '{a}'::text[]) $$,
  'the hook got the trimmed title and distinct categories, once');

-- ------------------------------------------------------------------ support context
delete from app.support_requests;
create or replace function private.ext_support_context(p_org_id uuid) returns jsonb
language sql stable set search_path = '' as $$ select '{"plan": "pro", "role": "spoofed"}'::jsonb $$;
select tests.act_as('staff');
select api.contact_support(tests.id('org_a'), 'Help', 'It broke');
select tests.as_postgres();
select results_eq($$ select context ->> 'plan', context ->> 'role' from app.support_requests $$,
  $$ values ('pro', 'staff') $$, 'the request context carries the hook''s facts; built-in fields win');
select is((select n.vars ->> 'plan' from app.notifications n where n.template_key = 'support_request'), 'pro',
  'and so does the support inbox email');

create or replace function private.ext_support_context(p_org_id uuid) returns jsonb
language sql stable set search_path = '' as $$ select '{"route": "/spoofed", "user_email": "x@example.test"}'::jsonb $$;
select tests.act_as('staff');
select api.contact_support(tests.id('org_a'), 'Help again', 'Still broken');
select tests.as_postgres();
select is((select context ->> 'route' from app.support_requests where subject = 'Help again'), null,
  'a hook key naming a built-in field is dropped even when that field is empty');

create or replace function private.ext_support_context(p_org_id uuid) returns jsonb
language sql stable set search_path = '' as $$ select '["not", "an", "object"]'::jsonb $$;
select tests.act_as('staff');
select api.contact_support(tests.id('org_a'), 'Third', 'Another one');
select tests.as_postgres();
select is((select jsonb_typeof(context) from app.support_requests where subject = 'Third'), 'object',
  'a hook answer that is not an object is ignored');

-- ------------------------------------------------------------------ purge and price
select is(private.ext_purge_keep_tables(), '{}'::text[], 'here the purge keeps no table');
select ok((select prosrc from pg_proc where oid = 'ops.purge_deleted_orgs()'::regprocedure) like '%private.ext_purge_keep_tables()%',
  'ops.purge_deleted_orgs leaves out the tables the hook names');

insert into app.guest_contacts (id, org_id, guest_id, channel, value, country_code, created_source) values
  (tests.new_id('phone_h'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550177', 'US', 'online');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version,
                               dedupe_key, status, provider, provider_message_id, cost_micros, cost_source, sent_at) values
  (tests.new_id('h1'), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('phone_h'), 'called', 1, 'h1', 'sent',
   'twilio', 'SM_h1', 7900, 'estimate', now() - interval '20 minutes'),
  (tests.new_id('h2'), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('phone_h'), 'called', 1, 'h2', 'sent',
   'twilio', 'SM_h2', 7900, 'estimate', now() - interval '20 minutes');
create table tests.price_calls (old bigint, new bigint);
create or replace function private.ext_price_changed(p_org_id uuid, p_notification_id uuid, p_old_micros bigint,
  p_new_micros bigint) returns void
language sql volatile set search_path = '' as $$ insert into tests.price_calls values (p_old_micros, p_new_micros) $$;
select tests.as_service();
select api.apply_provider_price(tests.id('org_a'), tests.id('h1'), -0.0100, 'USD');
select api.apply_provider_price(tests.id('org_a'), tests.id('h2'), -0.0079, 'USD');
select tests.as_postgres();
select results_eq($$ select old, new from tests.price_calls $$, $$ values (7900::bigint, 10000::bigint) $$,
  'a changed price reaches the hook with the old and new cost; an unchanged one does not');

select * from finish();
rollback;
