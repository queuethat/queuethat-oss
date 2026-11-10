-- C9 (#1275): breach notices (draft, approve, send through the outbox) and the tenant incident log.
begin;
\ir ../helpers/_setup.psql
select plan(50);
select tests.create_world();

create table tests.keep (name text primary key, id uuid);
grant all on tests.keep to authenticated;

-- ------------------------------------------------------------------ operator drafts from a template
select tests.act_as('platform');
insert into tests.keep select 'inc', id from api.platform_create_incident('data_exposure', 'Log leak',
  now() - interval '2 hours', 'Session tokens were written to a log', array[tests.id('org_a')], array['contact'], 40);
select lives_ok($$ insert into tests.keep select 'n', id from api.platform_save_notice((select id from tests.keep where name = 'inc')) $$,
  'an operator drafts a notice');
select results_eq($$ select status, org_count from api.platform_list_notices((select id from tests.keep where name = 'inc')) $$,
  $$ values ('draft', 0) $$, 'it starts as a draft told to nobody');
select ok((select body like '%Session tokens were written to a log%' and body like '%contact%' from api.platform_list_notices((select id from tests.keep where name = 'inc'))),
  'the template is filled from the incident');
select is((select count(*)::int from app.notifications where template_key = 'incident_notice'), 0, 'drafting queues nothing');
select throws_ok($$ select api.platform_send_notice((select id from tests.keep where name = 'n')) $$, 'P0001', 'invalid_input',
  'a draft is never sent');
select is((select count(*)::int from app.notifications where template_key = 'incident_notice'), 0, 'and still nothing is queued');
select is((select id from api.platform_save_notice((select id from tests.keep where name = 'inc'), p_subject => 'Please read: log leak')),
  (select id from tests.keep where name = 'n'), 'saving again edits the same open notice');
select lives_ok($$ select api.platform_approve_notice((select id from tests.keep where name = 'n')) $$, 'an operator approves it');
select is((select status from api.platform_list_notices((select id from tests.keep where name = 'inc'))), 'approved', 'approved');
select is((select status from api.platform_save_notice((select id from tests.keep where name = 'inc'), p_body => 'Edited text after approval')),
  'draft', 'an edit after approval returns it to draft');
select throws_ok($$ select api.platform_send_notice((select id from tests.keep where name = 'n')) $$, 'P0001', 'invalid_input',
  'so an edited notice cannot be sent unapproved');

-- ------------------------------------------------------------------ nobody else reaches it
select tests.act_as('owner');
select throws_ok($$ select api.platform_save_notice(tests.id('incident_a')) $$, '42501', 'permission_denied', 'a tenant owner cannot draft');
select throws_ok($$ select api.platform_send_notice((select id from tests.keep where name = 'n')) $$, '42501', 'permission_denied', 'a tenant owner cannot send');
select is((select count(*)::int from app.incident_notices), 0, 'a tenant owner reads no drafts');
select tests.as_anon();
select throws_ok($$ select api.platform_approve_notice(gen_random_uuid()) $$, '42501', null, 'anon cannot call it');

-- ------------------------------------------------------------------ send: outbox, log, clock
select tests.act_as('platform');
select lives_ok($$ select api.platform_approve_notice((select id from tests.keep where name = 'n')) $$, 'approved again');
select lives_ok($$ select api.platform_send_notice((select id from tests.keep where name = 'n')) $$, 'an operator sends it');
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'incident_notice' and org_id = tests.id('org_a')),
  (select count(*)::int from app.memberships where org_id = tests.id('org_a') and role = 'owner') + 1,
  'it is queued in the outbox for each owner of the org and for its privacy contact');
select is((select private.notification_address('email', null, n.recipient_ref, n.org_id) from app.notifications n
  where n.template_key = 'incident_notice' and n.recipient_ref = tests.id('org_a')), 'privacy@example.test',
  'the contact row resolves to the recorded breach contact address');
select is((select count(*)::int from app.notifications where template_key = 'incident_notice' and org_id = tests.id('org_a')
  and recipient_ref = tests.id('org_a')), 1, 'once');
select is(private.notification_address('email', null, tests.id('org_a'), tests.id('org_b')), null,
  'another org cannot resolve the contact through its own id');
select is((select count(*)::int from app.notifications where template_key = 'incident_notice' and org_id <> tests.id('org_a')), 0,
  'and for nobody outside the incident''s scope');
select tests.act_as('platform');
select results_eq($$ select status, org_count, acknowledged_count from api.platform_list_notices((select id from tests.keep where name = 'inc')) $$,
  $$ values ('sent', 1, 0) $$, 'it counts the businesses told and none acknowledged');
select is((select notify_state from api.platform_list_incidents(p_id => (select id from tests.keep where name = 'inc'))), 'done',
  'sending stops the 72-hour clock');
select lives_ok($$ select api.platform_send_notice((select id from tests.keep where name = 'n')) $$, 'sending again is a no-op');
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'incident_notice'),
  (select count(*)::int from app.memberships where org_id = tests.id('org_a') and role = 'owner') + 1, 'nothing is queued twice');

-- ------------------------------------------------------------------ the business sees and acknowledges it
select tests.act_as('admin');
select is((select count(*)::int from app.org_incident_log where source = 'platform_notice' and acknowledged_at is null), 1,
  'an admin sees the unacknowledged notice');
select is((select title from app.org_incident_log where source = 'platform_notice'), 'Please read: log leak', 'prefilled with its subject');
select lives_ok($$ select api.acknowledge_incident_notice((select id from app.org_incident_log where source = 'platform_notice')) $$, 'an admin acknowledges it');
select lives_ok($$ select api.acknowledge_incident_notice((select id from app.org_incident_log where source = 'platform_notice')) $$, 'again is a no-op');
select ok((select acknowledged_at is not null and acknowledged_by = tests.id('admin') from app.org_incident_log where source = 'platform_notice'),
  'who and when are recorded');
select lives_ok($$ select api.update_incident_log_entry((select id from app.org_incident_log where source = 'platform_notice'),
  p_people_affected => 12, p_actions_taken => 'Reset staff passwords', p_regulator_notified => 'Told the regulator on day 2') $$,
  'the business adds what it did');
select is((select people_affected from app.org_incident_log where source = 'platform_notice'), 12, 'it is stored');
select throws_ok($$ select api.update_incident_log_entry((select id from app.org_incident_log where source = 'platform_notice'), p_people_affected => -1) $$,
  'P0001', 'invalid_input', 'a negative count is invalid');
select throws_ok($$ update app.org_incident_log set notice_body = 'changed' $$, '42501', null, 'the notice text cannot be edited directly');
select throws_ok($$ delete from app.org_incident_log $$, '42501', null, 'the 24-month record cannot be deleted');
select tests.act_as('platform');
select is((select acknowledged_count from api.platform_list_notices((select id from tests.keep where name = 'inc'))), 1, 'the platform sees the acknowledgment');

-- ------------------------------------------------------------------ other tenants and roles
select tests.act_as('other_owner');
select is((select count(*)::int from app.org_incident_log), 0, 'another business reads none of it');
select throws_ok($$ select api.acknowledge_incident_notice((select id from app.org_incident_log)) $$, 'P0001', 'not_found', 'and cannot acknowledge it');
select throws_ok($$ select api.report_incident(tests.id('org_a'), 'other', 'x') $$, '42501', 'permission_denied', 'nor report for it');
select tests.act_as('staff');
select is((select count(*)::int from app.org_incident_log), 0, 'staff read none of it');
select throws_ok($$ select api.report_incident(tests.id('org_a'), 'other', 'x') $$, '42501', 'permission_denied', 'staff cannot report');

-- ------------------------------------------------------------------ report a suspected incident
select tests.act_as('owner');
select lives_ok($$ insert into tests.keep select 'rep', api.report_incident(tests.id('org_a'), 'lost_device', 'Phone lost',
  'A staff phone with the console signed in', null, array['contact'], true, '22222222-2222-2222-2222-222222222222') $$,
  'an owner reports a suspected incident');
select is(api.report_incident(tests.id('org_a'), 'lost_device', 'Phone lost', null, null, '{}', true, '22222222-2222-2222-2222-222222222222'),
  (select id from tests.keep where name = 'rep'), 'repeating the key returns the same entry');
select throws_ok($$ select api.report_incident(tests.id('org_a'), 'nope', 'x') $$, 'P0001', 'invalid_input', 'a bad kind is invalid');
select tests.act_as('platform');
select is((select count(*)::int from api.platform_list_incidents('suspected') where title = 'Phone lost' and org_ids = array[tests.id('org_a')]), 1,
  'it is a platform incident for that business, clock running');
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'incident_reported_operator'),
  (select count(*)::int from app.platform_roles where role = 'operator'), 'every operator is emailed once');

-- ------------------------------------------------------------------ C9b (#1342): the breach contact
-- Org B has no privacy contact: owners only. Org A's contact reuses an owner's address: still one mail.
select tests.act_as('platform');
insert into tests.keep select 'inc_b', id from api.platform_create_incident('other', 'B notice',
  now() - interval '1 hour', 'x', array[tests.id('org_b')], array['contact'], null);
insert into tests.keep select 'n_b', id from api.platform_save_notice((select id from tests.keep where name = 'inc_b'));
select api.platform_approve_notice((select id from tests.keep where name = 'n_b'));
select api.platform_send_notice((select id from tests.keep where name = 'n_b'));
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'incident_notice' and org_id = tests.id('org_b')),
  (select count(*)::int from app.memberships where org_id = tests.id('org_b') and role = 'owner'),
  'an org without a recorded contact gets owner mail only');
update app.org_privacy set email = (select u.email from app.memberships m join auth.users u on u.id = m.user_id
  where m.org_id = tests.id('org_a') and m.role = 'owner' limit 1) where org_id = tests.id('org_a');
select tests.act_as('platform');
insert into tests.keep select 'inc_c', id from api.platform_create_incident('other', 'C notice',
  now() - interval '1 hour', 'y', array[tests.id('org_a')], array['contact'], null);
insert into tests.keep select 'n_c', id from api.platform_save_notice((select id from tests.keep where name = 'inc_c'));
select api.platform_approve_notice((select id from tests.keep where name = 'n_c'));
select api.platform_send_notice((select id from tests.keep where name = 'n_c'));
select tests.as_postgres();
select is((select count(*)::int from app.notifications n where n.template_key = 'incident_notice' and n.org_id = tests.id('org_a')
  and n.dedupe_key like 'incident_notice:' || (select id from tests.keep where name = 'n_c') || '%'),
  (select count(*)::int from app.memberships where org_id = tests.id('org_a') and role = 'owner'),
  'a contact whose address an owner already has adds no second mail');
select is((select count(*)::int from app.notifications where template_key = 'incident_notice' and recipient_ref = tests.id('org_b')), 0,
  'org B never gets a contact row it has no contact for');

select * from finish();
rollback;
