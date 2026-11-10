-- W2 (#1304): the waiver acceptance evidence record (written by trigger, immutable, retention, tenancy).
begin;
\ir ../helpers/_setup.psql
select plan(20);
select tests.create_world();
select tests.new_id(k) from unnest(array['j1','j2','j3','s1','f_ag','v_ag','v_ag_opt','f_opt','resp_apt']) k;

delete from app.business_hours;
delete from app.intake_fields;
delete from app.org_privacy where org_id = tests.id('org_a');
insert into app.org_privacy (org_id, officer_name, email, jurisdiction) values (tests.id('org_a'), 'Pat Privacy', 'privacy@a.test', 'ca');

create temp table ag as select '[
  {"key":"terms","label":"Studio waiver","type":"agreement","body":"I understand the risks.","required":true},
  {"key":"sig","label":"Sign here","type":"signature","collect_guardian":true,"required":true}
]'::jsonb as f;
create temp table ag_opt as select '[{"key":"terms","label":"Photo release","type":"agreement","body":"Photos may be posted."}]'::jsonb as f;

insert into app.forms (id, org_id, location_id, name) values
  (tests.id('f_ag'), tests.id('org_a'), tests.id('loc_a'), 'Waiver'),
  (tests.id('f_opt'), tests.id('org_a'), tests.id('loc_a'), 'Photo');
insert into app.form_versions (id, org_id, location_id, form_id, version, fields, published_at) values
  (tests.id('v_ag'), tests.id('org_a'), tests.id('loc_a'), tests.id('f_ag'), 1, (select f from ag), now()),
  (tests.id('v_ag_opt'), tests.id('org_a'), tests.id('loc_a'), tests.id('f_opt'), 1, (select f from ag_opt), now());
insert into app.form_targets (org_id, location_id, form_id, queue_id) values (tests.id('org_a'), tests.id('loc_a'), tests.id('f_ag'), tests.id('queue_a'))
on conflict (queue_id, channel) where queue_id is not null do update set form_id = excluded.form_id;
select tests.as_postgres();
delete from app.waiver_acceptances;

-- Join with an agreement: one evidence row (1 to 8).
select tests.as_anon();
select set_config('request.headers', '{"x-real-ip": "198.51.100.58"}', true);
create temp table joined as
select to_jsonb(api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'Ann', p_phone_e164 => null, p_email => null,
  p_party_size => 1, p_locale => null, p_idempotency_key => tests.id('j1'),
  p_answers => '{"terms":true,"sig":{"name":"  Ann Lee ","guardian_name":"Bo Lee"}}')) as r;
grant select on joined to authenticated, anon;
select tests.as_postgres();
create temp table vis as select id, version from app.visits where idempotency_key = tests.id('j1');
grant select on vis to authenticated;

select is((select count(*)::int from app.waiver_acceptances), 1, 'W2: joining with an agreement writes one acceptance row');
select is((select typed_name || '/' || guardian_name from app.waiver_acceptances), 'Ann Lee/Bo Lee', 'it holds the typed name and guardian');
select is((select text_hash from app.waiver_acceptances),
  encode(extensions.digest(convert_to('Studio waiver' || E'\n' || 'I understand the risks.', 'utf8'), 'sha256'), 'hex'), 'and the hash of the text shown');
select is((select form_version_id from app.waiver_acceptances), tests.id('v_ag'), 'and the form version');
select ok((select accepted_at between now() - interval '1 minute' and now() + interval '1 minute' and signed_at is not null from app.waiver_acceptances), 'accepted_at is server time and the signature is stamped');
select is((select subject_kind || ':' || (subject_id = (select id from vis))::text from app.waiver_acceptances), 'visit:true', 'the subject is the visit');
select is((select count(*)::int from information_schema.columns where table_schema = 'app' and table_name = 'waiver_acceptances'
           and column_name ~* '(ip|addr|fingerprint|agent|device|header)'), 0, 'no IP, user agent or device column exists');
select ok(not (select r::text ~ '(text_hash|Ann Lee|accepted_at)' from joined), 'the guest response carries none of it (I-13)');

-- Staff edits keep the one record (9 to 10); evidence cannot be edited (11).
select tests.act_as('staff');
select lives_ok($$ select api.set_visit_answers((select id from vis), '{}', (select version from vis), tests.id('s1')) $$, 'staff replace the answers');
select tests.as_postgres();
select is((select count(*)::int from app.waiver_acceptances where typed_name = 'Ann Lee'), 1, 'still exactly one record, unchanged');
select throws_ok($$ update app.waiver_acceptances set typed_name = 'Eve' $$, '42501', 'immutable_column', 'an acceptance is never updated');

-- Optional agreement without a signature (12); an unticked one writes nothing (13).
insert into app.form_responses (id, org_id, location_id, form_version_id, appointment_id, answers)
values (tests.id('resp_apt'), tests.id('org_a'), tests.id('loc_a'), tests.id('v_ag_opt'), tests.id('appointment_a'),
        private.validate_form_answers(tests.id('org_a'), (select f from ag_opt), '{"terms":true}', 'guest'));
select is((select coalesce(typed_name, 'none') || ':' || subject_kind from app.waiver_acceptances where form_response_id = tests.id('resp_apt')), 'none:appointment', 'a booking records the appointment as subject; no signature field means no typed name');
update app.form_responses set answers = '{}' where id = tests.id('resp_apt');
select is((select count(*)::int from app.waiver_acceptances where form_response_id = tests.id('resp_apt')), 1, 'clearing the answers does not erase evidence already recorded');
select is((select count(*)::int from app.waiver_acceptances), 2, 'two records in all');

-- Tenancy (15 to 19).
select tests.act_as('staff');
select is((select count(*)::int from app.waiver_acceptances), 2, 'staff of the location read the records');
select throws_ok($$ insert into app.waiver_acceptances (org_id, location_id, form_response_id, form_version_id, field_key, text_hash, accepted_at, subject_kind, subject_id)
  select org_id, location_id, form_response_id, form_version_id, 'x', repeat('b', 64), now(), 'visit', subject_id from app.waiver_acceptances limit 1 $$,
  '42501', null, 'authenticated cannot write records');
select tests.act_as('other_owner');
select is((select count(*)::int from app.waiver_acceptances), 0, 'cross-tenant: another org reads nothing');
select tests.as_anon();
select throws_ok($$ select count(*) from app.waiver_acceptances $$, '42501', null, 'anon has no access');

-- Retention (20 to 21): anonymising the visit removes the answers; the evidence follows its own waiver period (W7).
select tests.as_postgres();
select is(private.anonymize_visits(tests.id('org_a'), array[(select id from vis)]), 1, 'retention anonymises the visit');
select is((select count(*)::int from app.waiver_acceptances where typed_name = 'Ann Lee'), 1, 'but its acceptance record stays until the waiver retention period ends');

select * from finish();
rollback;
