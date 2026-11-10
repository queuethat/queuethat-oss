-- #443: account emails through the outbox: one per owner of the org, to their sign-in address.
begin;
\ir ../helpers/_setup.psql
select plan(12);
select tests.create_world();

-- Org A gets a second owner; the fixture visit notification is already due.
select tests.create_user('owner2');
insert into app.memberships (org_id, user_id, role) values (tests.id('org_a'), tests.id('owner2'), 'owner');

-- The waiver-records reminder is an account email; queueing it twice in the same scope sends it once.
select private.enqueue_account_email(tests.id('org_a'), 'waiver_records_expiring',
  jsonb_build_object('org', 'Org A', 'count', '7', 'first_date', 'January 1, 2027 UTC'), 'fixture-scope');
select private.enqueue_account_email(tests.id('org_a'), 'waiver_records_expiring',
  jsonb_build_object('org', 'Org A', 'count', '8', 'first_date', 'January 1, 2027 UTC'), 'fixture-scope');

select results_eq(
  $$ select recipient_ref, channel::text, category::text, template_key, vars ->> 'count', vars ->> 'org'
     from app.notifications where visit_id is null order by recipient_ref $$,
  $$ select * from (values (tests.id('owner'), 'email', 'transactional', 'waiver_records_expiring', '7', 'Org A'),
                           (tests.id('owner2'), 'email', 'transactional', 'waiver_records_expiring', '7', 'Org A')) x
     order by 1 $$,
  'AC1: an account email is queued once per owner of the org');
select is((select count(*) from app.notifications where visit_id is null and org_id = tests.id('org_b')), 0::bigint,
  'other orgs'' owners get nothing');

create table tests.jobs of api.outbox_job;
grant all on tests.jobs to service_role;
select tests.as_service();
insert into tests.jobs select * from api.claim_outbox(50, 60);
select tests.as_postgres();
select is((select count(*)::int from tests.jobs), 3, 'claim_outbox returns the account emails with the visit notification');
select results_eq(
  $$ select recipient, has_consent, is_suppressed, location_tz, locale, subject from tests.jobs
     where visit_id is null order by recipient ->> 'value' collate "C" desc $$,
  $$ values ('{"kind": "address", "value": "owner@test.local"}'::jsonb, true, false, null::text, 'en', '{org}: waiver records will be deleted soon'),
            ('{"kind": "address", "value": "owner2@test.local"}'::jsonb, true, false, null::text, 'en', '{org}: waiver records will be deleted soon') $$,
  'AC1: claim_outbox resolves the owner''s sign-in email, consent, locale and template');
select is((select recipient ->> 'kind' from tests.jobs where visit_id = tests.id('visit_a')), 'push',
  'AC2: the visit notification still claims as before');
select tests.as_service();
select ok(api.outbox_still_relevant((select id from tests.jobs where visit_id is null limit 1)),
  'account mail is still relevant');
select is(api.outbox_still_relevant(tests.id('notification_a')), false,
  'AC2: visit rows are judged as before (a called message for a guest still waiting is not sent)');
select tests.as_postgres();

-- A suppressed owner address is reported as suppressed.
insert into app.suppressions (org_id, channel, value, reason) values (tests.id('org_a'), 'email', 'owner2@test.local', 'bounce');
update app.notifications set status = 'queued', locked_until = null where visit_id is null;
delete from tests.jobs;
select tests.as_service();
insert into tests.jobs select * from api.claim_outbox(50, 60);
select tests.as_postgres();
select is((select is_suppressed from tests.jobs where recipient ->> 'value' = 'owner2@test.local'), true,
  'a suppressed owner address is reported as suppressed');

-- Visibility and shape.
select tests.act_as('staff');
select is((select count(*) from app.notifications where visit_id is null), 0::bigint,
  'staff do not see account mail');
select is((select count(*) from app.notifications where visit_id = tests.id('visit_a')), 1::bigint,
  'staff still see visit notifications');
select tests.act_as('admin');
select is((select count(*) from app.notifications where visit_id is null), 2::bigint, 'admins see account mail');
select tests.as_postgres();
select throws_ok($$ insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key,
                      template_version, category, dedupe_key)
                    values (tests.id('org_a'), null, 'email', tests.id('owner'), 'x', 1, 'marketing', 'm1') $$,
  '23514', null, 'a row without a visit is never marketing');

select * from finish();
rollback;
