-- W1 (#1303): agreement and signature field types (validation, evidence, publish gate, join, staff edits).
begin;
\ir ../helpers/_setup.psql
select plan(39);
select tests.create_world();
select tests.new_id(k) from unnest(array['j1','j2','j3','s1','s2','f_ag','v_ag','v_ag2']) k;

create function tests.error_detail(p_sql text) returns text
language plpgsql as $$
declare d text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return d;
end $$;
grant execute on function tests.error_detail(text) to anon, authenticated;

delete from app.business_hours;
delete from app.intake_fields;

create temp table ag as select '[
  {"key":"terms","label":"Studio waiver","type":"agreement","body":"I understand the risks.\n\n- No refunds\n- **Bring ID**","required":true},
  {"key":"sig","label":"Sign here","type":"signature","collect_guardian":true,"required":true}
]'::jsonb as f;
create temp table ag_opt as select '[
  {"key":"terms","label":"Photo release","type":"agreement","body":"Photos may be posted."},
  {"key":"sig","label":"Sign here","type":"signature"}
]'::jsonb as f;
grant select on ag, ag_opt to anon, authenticated;

-- Field validation (1 to 8).
select lives_ok($$ select private.validate_form_fields((select f from ag)) $$, 'W1: an agreement and a signature validate');
select is(tests.error_detail($$ select private.validate_form_fields('[{"key":"a","label":"A","type":"agreement"},{"key":"s","label":"S","type":"signature"}]') $$), 'body', 'an agreement needs a body');
select is(tests.error_detail($$ select private.validate_form_fields('[{"key":"a","label":"A","type":"agreement","body":"<b>x</b>"},{"key":"s","label":"S","type":"signature"}]') $$), 'body', 'HTML in a body is refused');
select is(tests.error_detail($$ select private.validate_form_fields(jsonb_build_array(jsonb_build_object('key','a','label','A','type','agreement','body',repeat('x',8001)), '{"key":"s","label":"S","type":"signature"}'::jsonb)) $$), 'body', 'a body over 8000 characters is refused');
select is(tests.error_detail($$ select private.validate_form_fields('[{"key":"a","label":"A","type":"short_text","body":"x"}]') $$), 'body', 'body belongs to agreements only');
select is(tests.error_detail($$ select private.validate_form_fields('[{"key":"a","label":"A","type":"agreement","body":"x","collect_guardian":true},{"key":"s","label":"S","type":"signature"}]') $$), 'collect_guardian', 'collect_guardian belongs to signatures only');
select is(tests.error_detail($$ select private.validate_form_fields('[{"key":"s","label":"S","type":"signature"}]') $$), 'signature_without_agreement', 'a signature needs an agreement in the form');
select is(tests.error_detail($$ select private.validate_form_fields('[{"key":"a","label":"A","type":"agreement","body":"x","visibility":"staff_only"}]') $$), 'visibility', 'an agreement cannot be staff-only');

-- Answers (9 to 22).
select is(private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":true,"sig":{"name":"  Ann Lee ","guardian_name":" Bo Lee "}}', 'guest') #>> '{terms,accepted}', 'true', 'ticking stores accepted');
select is(private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":true,"sig":{"name":"Ann Lee"}}', 'guest') #>> '{terms,text_hash}',
  encode(extensions.digest(convert_to('Studio waiver' || E'\n' || E'I understand the risks.\n\n- No refunds\n- **Bring ID**', 'utf8'), 'sha256'), 'hex'), 'the hash is sha256 of label, newline and body');
select ok((private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":true,"sig":{"name":"Ann Lee"}}', 'guest') #>> '{terms,accepted_at}')::timestamptz
  between now() - interval '1 minute' and now() + interval '1 minute', 'accepted_at is server time');
select is(private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":true,"sig":{"name":"  Ann Lee ","guardian_name":" Bo Lee "}}', 'guest') #>> '{sig,name}', 'Ann Lee', 'the signed name is trimmed');
select is(private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":true,"sig":{"name":"Ann Lee","guardian_name":" Bo Lee "}}', 'guest') #>> '{sig,guardian_name}', 'Bo Lee', 'a guardian name is kept when the field collects it');
select ok(private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":true,"sig":{"name":"Ann Lee","guardian_name":""}}', 'guest') -> 'sig' ? 'signed_at'
  and not (private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":true,"sig":{"name":"Ann Lee","guardian_name":""}}', 'guest') -> 'sig' ? 'guardian_name'), 'signed_at is stamped and a blank guardian is dropped');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from ag_opt), '{"terms":true,"sig":{"name":"Ann Lee","guardian_name":"Bo"}}', 'guest') $$), 'sig', 'a guardian is refused when the field does not collect one');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"sig":{"name":"Ann Lee"}}', 'guest') $$), 'terms', 'a required agreement must be accepted');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":false,"sig":{"name":"Ann Lee"}}', 'guest') $$), 'terms', 'unticked counts as not accepted');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":true}', 'guest') $$), 'sig', 'a required signature is enforced');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":true,"sig":{"name":""}}', 'guest') $$), 'sig', 'an empty name is not a signature');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":{"accepted":true,"text_hash":"x","accepted_at":"2001-01-01"},"sig":{"name":"Ann Lee"}}', 'guest') $$), 'terms', 'the client cannot supply its own evidence');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":true,"sig":{"name":"A"}}', 'guest') $$), 'sig', 'a one-character name is refused');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":true,"sig":{"name":"4111 1111 1111 1111"}}', 'guest') $$), 'sig', 'a card number is not a name');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":true,"sig":{"name":"Ann Lee","signed_at":"2001-01-01"}}', 'guest') $$), 'sig', 'a signature takes no other keys (signed_at is server time)');
select is(private.validate_form_answers(tests.id('org_a'), (select f from ag_opt), '{"terms":false}', 'guest'), '{}'::jsonb, 'an optional agreement left unticked stores nothing');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"terms":true}', 'staff') $$), 'terms', 'staff cannot accept an agreement for a guest');
select is(tests.error_detail($$ select private.validate_form_answers(tests.id('org_a'), (select f from ag), '{"sig":{"name":"Ann Lee"}}', 'staff') $$), 'sig', 'nor sign for one');
select is(private.validate_form_answers(tests.id('org_a'), (select f from ag), '{}', 'staff'), '{}'::jsonb, 'but staff are not required to');

-- Publish gate (27 to 29): an agreement goes live only with a privacy contact.
select tests.as_postgres();
delete from app.org_privacy where org_id = tests.id('org_a');
insert into app.forms (id, org_id, location_id, name) values (tests.id('f_ag'), tests.id('org_a'), tests.id('loc_a'), 'Waiver');
insert into app.form_versions (id, org_id, location_id, form_id, version, fields)
values (tests.id('v_ag'), tests.id('org_a'), tests.id('loc_a'), tests.id('f_ag'), 1, (select f from ag));
select is(tests.error_detail($$ update app.form_versions set published_at = now() where id = tests.id('v_ag') $$), 'privacy_contact_required', 'publishing an agreement needs the privacy contact');
select is((select published_at from app.form_versions where id = tests.id('v_ag')), null, 'and the version stays a draft');
insert into app.org_privacy (org_id, officer_name, email, jurisdiction) values (tests.id('org_a'), 'Pat Privacy', 'privacy@a.test', 'ca');
update app.form_versions set published_at = now() where id = tests.id('v_ag');
select ok((select text_hash is not null from app.form_versions where id = tests.id('v_ag')), 'with a contact it publishes and gets its hash');
insert into app.form_targets (org_id, location_id, form_id, queue_id) values (tests.id('org_a'), tests.id('loc_a'), tests.id('f_ag'), tests.id('queue_a'))
on conflict (queue_id, channel) where queue_id is not null do update set form_id = excluded.form_id;

-- A guest sees the text and joins (30 to 34); org B's staff cannot touch the evidence (35).
select tests.as_anon();
select set_config('request.headers', '{"x-real-ip": "198.51.100.57"}', true);
select is(api.get_join_form(tests.id('queue_a')) #>> '{fields,0,body}', E'I understand the risks.\n\n- No refunds\n- **Bring ID**', 'get_join_form publishes the agreement text');
select is(api.get_join_form(tests.id('queue_a')) #>> '{fields,1,collect_guardian}', 'true', 'and the guardian flag');
select is(tests.error_detail($$ select api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'Ann', p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => null, p_idempotency_key => tests.id('j1'), p_answers => '{"sig":{"name":"Ann Lee"}}') $$), 'terms', 'join refuses a missing required agreement');
select lives_ok($$ select api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'Ann', p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => null, p_idempotency_key => tests.id('j2'), p_answers => '{"terms":true,"sig":{"name":"Ann Lee"}}') $$, 'join with the agreement and a signature succeeds');
select tests.as_postgres();
select is((select r.answers #>> '{terms,text_hash}' from app.form_responses r join app.visits v on v.id = r.visit_id where v.idempotency_key = tests.id('j2')),
  encode(extensions.digest(convert_to('Studio waiver' || E'\n' || E'I understand the risks.\n\n- No refunds\n- **Bring ID**', 'utf8'), 'sha256'), 'hex'), 'the response records what was accepted');
create temp table v1 as select id, version from app.visits where idempotency_key = tests.id('j2');
grant select on v1 to authenticated;
select tests.act_as('staff');
select lives_ok($$ select api.set_visit_answers((select id from v1), '{}', (select version from v1), tests.id('s1')) $$, 'staff replacing the answers');
select tests.as_postgres();
select is((select r.answers #>> '{sig,name}' from app.form_responses r where r.visit_id = (select id from v1)), 'Ann Lee', 'keeps the signature');
select tests.act_as('staff');
select is(tests.error_detail($$ select api.set_visit_answers((select id from v1), '{"terms":true}', (select version from app.visits where id = (select id from v1)), tests.id('s2')) $$), 'terms', 'but staff cannot add an acceptance');
select tests.act_as('other_owner');
select throws_ok($$ select api.set_visit_answers((select id from v1), '{}', (select version from v1), gen_random_uuid()) $$, 'P0001', 'not_found', 'cross-tenant: another org cannot edit the response');

select * from finish();
rollback;
