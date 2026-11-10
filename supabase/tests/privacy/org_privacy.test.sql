-- C7 (#1273): the privacy officer and breach contact; the gates it feeds; the guest notice.
begin;
\ir ../helpers/_setup.psql
select plan(28);
select tests.create_world();

create function tests.error_of(p_sql text) returns text
language plpgsql as $$
declare d text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return sqlstate || ' ' || sqlerrm || coalesce(' [' || nullif(d, '') || ']', '');
end $$;
grant execute on function tests.error_of(text) to authenticated, service_role;

-- Org B has no contact yet; org A's world fixture has one.
select tests.as_postgres();
select ok(private.privacy_contact_recorded(tests.id('org_a')), 'a recorded contact counts');
select ok(not private.privacy_contact_recorded(tests.id('org_b')), 'no row, no contact');
select is(private.org_breach_contact(tests.id('org_a')) ->> 'email', 'privacy@example.test', 'C8 reads the breach contact from the table');
select is(private.org_breach_contact(tests.id('org_b')), null, 'and gets null for an org without one');

-- Writes: admins and owners only; validated.
select tests.act_as('manager');
select ok(exists (select 1 from app.org_privacy where org_id = tests.id('org_a')), 'a manager can read the contact');
select is(tests.error_of($$ update app.org_privacy set officer_name = 'Hacked' where org_id = tests.id('org_a') $$), 'ok', 'a manager update is silently a no-op');
select tests.act_as('staff');
select is((select count(*)::int from app.org_privacy), 0, 'staff cannot read the contact');
select tests.act_as('admin');
select is(tests.error_of($$ update app.org_privacy set email = 'not-an-email' where org_id = tests.id('org_a') $$), '23514 new row for relation "org_privacy" violates check constraint "org_privacy_email_check"', 'the email must look like one');
select is(tests.error_of($$ update app.org_privacy set jurisdiction = 'mars' where org_id = tests.id('org_a') $$), '23514 new row for relation "org_privacy" violates check constraint "org_privacy_jurisdiction_check"', 'the jurisdiction is one of the list');
select is(tests.error_of($$ update app.org_privacy set officer_name = '  ' where org_id = tests.id('org_a') $$), '23514 new row for relation "org_privacy" violates check constraint "org_privacy_officer_name_check"', 'the name cannot be blank');
select is(tests.error_of($$ update app.org_privacy set notice_prefs = '{"x":1}' where org_id = tests.id('org_a') $$), '23514 new row for relation "org_privacy" violates check constraint "org_privacy_notice_prefs_check"', 'notice_prefs allows only show_phone');
select is(tests.error_of($$ update app.org_privacy set notice_prefs = '{"show_phone":"yes"}' where org_id = tests.id('org_a') $$), '23514 new row for relation "org_privacy" violates check constraint "org_privacy_notice_prefs_check"', 'show_phone is a boolean');
select is(tests.error_of($$ update app.org_privacy set org_id = tests.id('org_b') where org_id = tests.id('org_a') $$), '42501 org_id is immutable', 'the row cannot move to another org');
select throws_ok($$ delete from app.org_privacy where org_id = tests.id('org_a') $$, '42501', null, 'nobody deletes it: no delete privilege');
select lives_ok($$ update app.org_privacy set officer_name = 'Dana Officer', phone = '+1 204 555 0100' where org_id = tests.id('org_a') $$, 'an admin edits it');
select tests.as_postgres();
select ok(exists (select 1 from app.audit_log where table_name = 'org_privacy' and org_id = tests.id('org_a') and action = 'UPDATE'), 'the change is audited');

-- Cross-tenant: org B's owner sees nothing of org A and cannot write into it or take its slot.
select tests.act_as('other_owner');
select is((select count(*)::int from app.org_privacy where org_id = tests.id('org_a')), 0, 'cross-tenant: org A''s contact is invisible to org B');
select throws_ok($$ insert into app.org_privacy (org_id, officer_name, email, jurisdiction)
  values (tests.id('org_a'), 'Eve', 'eve@example.test', 'us') on conflict (org_id) do update set officer_name = 'Eve' $$, '42501', null, 'cross-tenant: org B cannot write org A''s contact');
select lives_ok($$ insert into app.org_privacy (org_id, officer_name, email, jurisdiction)
  values (tests.id('org_b'), 'Bea', 'bea@example.test', 'us') $$, 'org B''s owner records its own');
select tests.as_postgres();
delete from app.org_privacy where org_id = tests.id('org_b');

-- Gate: sensitive field (C5 hook).
select tests.act_as('manager');
select is(tests.error_of($$ insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, sensitivity)
  values (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'meds', 'Medications', 'text', 'sensitive') $$), 'ok',
  'with a contact a sensitive field saves');
select tests.as_postgres();
update app.organizations set health_tagged = false where id = tests.id('org_a');
select is((select count(*)::int from app.intake_fields where key = 'meds'), 1, 'and it is there');

-- Gate: SMS. The missing list names privacy_contact only while there is no contact.
select tests.as_postgres();
select ok('privacy_contact' <> all (private.channel_missing(tests.id('org_a'), 'sms')), 'SMS: with a contact the item is not missing');
select ok('privacy_contact' = any (private.channel_missing(tests.id('org_b'), 'sms')), 'SMS: without a contact the item is missing');
select ok('privacy_contact' <> all (private.channel_missing(tests.id('org_b'), 'email')), 'and email does not need it');

-- Guest notice: anon sees name and email; the phone only when the business opted in.
select tests.as_anon();
select is((api.get_location_public('test-location-a')).privacy_contact ->> 'name', 'Dana Officer', 'the guest notice carries the officer name');
select is((api.get_location_public('test-location-a')).privacy_contact ? 'phone', false, 'and hides the phone by default');
select tests.as_postgres();
update app.org_privacy set notice_prefs = '{"show_phone": true}' where org_id = tests.id('org_a');
select tests.as_anon();
select is((api.get_location_public('test-location-a')).privacy_contact ->> 'phone', '+1 204 555 0100', 'the phone shows once the business opts in');
select throws_ok($$ select * from app.org_privacy $$, '42501', null, 'anon has no table access');

select * from finish();
rollback;
