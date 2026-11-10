-- W5 (#1307): owners hear 30 days before waiver records are deleted; the purge itself is unchanged.
begin;
\ir ../helpers/_setup.psql
select plan(11);
select tests.create_world();
select tests.create_user('owner2');
insert into app.memberships (org_id, user_id, role) values (tests.id('org_a'), tests.id('owner2'), 'owner');

select is((select count(*) from app.notification_templates where org_id is null and channel = 'email' and trigger = 'waiver_records_expiring'),
  1::bigint, 'the email has a system template');

delete from app.waiver_acceptances;
insert into app.waiver_acceptances (org_id, location_id, form_response_id, form_version_id, field_key, text_hash, accepted_at,
                                    typed_name, subject_kind, subject_id)
select tests.id('org_a'), tests.id('loc_a'), gen_random_uuid(), tests.id('form_version_a'), k, repeat('a', 64),
       now() - make_interval(days => d), 'Secret Typed Name', 'visit', tests.id('visit_a')
from (values ('soon', 345), ('later', 100)) as t (k, d);

select is(ops.send_waiver_purge_reminders() > 0, true, 'records due within 30 days queue a reminder');
select is((select count(*) from app.notifications where template_key = 'waiver_records_expiring' and org_id = tests.id('org_a')),
  (select count(*) from app.memberships where org_id = tests.id('org_a') and role = 'owner'), 'one email per owner');
select is((select count(*) from app.notifications n where template_key = 'waiver_records_expiring'
           and not exists (select 1 from app.memberships m where m.user_id = n.recipient_ref and m.org_id = n.org_id and m.role = 'owner')),
  0::bigint, 'nobody but owners is mailed');
select is((select distinct vars ->> 'count' from app.notifications where template_key = 'waiver_records_expiring'), '1', 'the count covers only records due soon');
select ok(not (select bool_or(vars::text ~* '(Secret Typed Name|text_hash)') from app.notifications where template_key = 'waiver_records_expiring'),
  'no guest-typed value reaches the message');
select is(ops.send_waiver_purge_reminders(), 0, 'a repeat run in the same month adds nothing');
select is((select count(*) from app.notifications where template_key = 'waiver_records_expiring' and org_id = tests.id('org_b')), 0::bigint,
  'an organisation with no waiver records is not mailed');

-- A longer tenant period moves the date out (9); the purge still runs on schedule (10 to 11).
delete from app.notifications where template_key = 'waiver_records_expiring';
update app.organizations set waiver_retention_days = 2555 where id = tests.id('org_a');
select is(ops.send_waiver_purge_reminders(), 0, 'with a 7 year period nothing is due, so no reminder');
update app.organizations set waiver_retention_days = 365 where id = tests.id('org_a');
insert into app.waiver_acceptances (org_id, location_id, form_response_id, form_version_id, field_key, text_hash, accepted_at,
                                    subject_kind, subject_id)
values (tests.id('org_a'), tests.id('loc_a'), gen_random_uuid(), tests.id('form_version_a'), 'overdue', repeat('a', 64),
        now() - interval '400 days', 'visit', tests.id('visit_a'));
select is(ops.waiver_retention_tick(), 1, 'the purge deletes the overdue record as scheduled');
select is((select count(*)::int from app.waiver_acceptances), 2, 'and keeps the others');

select * from finish();
rollback;
