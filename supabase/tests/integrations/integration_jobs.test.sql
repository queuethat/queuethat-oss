-- 4-INT1 (#395): the integration queue. Consent filter, tenancy, retries and the OAuth hand-off.
begin;
\ir ../helpers/_setup.psql
select plan(23);

select tests.create_world();

create function tests.error_of(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function tests.error_of(text) to anon, authenticated, service_role;

create function tests.serve(p_visit text) returns void
language plpgsql as $$
begin
  perform private.set_actor('system', null);
  insert into app.visit_events (org_id, visit_id, type, to_status, actor_kind)
  values (tests.id('org_a'), tests.id(p_visit), 'complete', 'served', 'system');
end $$;

select tests.as_postgres();
-- org A's Square connection is live; org B has its own
update app.provider_settings set enabled = true, verified_at = now(), config = '{"merchant_id":"MA"}' where id = tests.id('integration_setting_a');
delete from app.integration_jobs;

-- guest with a contact and consents
update app.guest_contacts set verified_at = now() where id = tests.id('contact_a');
update app.visits set contact_id = tests.id('contact_a'), guest_name = 'Gina' where id = tests.id('visit_a');
select tests.new_visit('visit_b', 'queue_a');

-- AC (consent): transactional consent alone does not sync
select tests.serve('visit_a');
select is((select count(*)::int from app.integration_jobs), 0, 'transactional consent alone queues nothing');

insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
values (tests.id('org_a'), tests.id('contact_a'), 'sms', 'marketing', 'granted', 'online', 'v1', 'hash');
select tests.serve('visit_a');
select is((select count(*)::int from app.integration_jobs where visit_id = tests.id('visit_a')), 1, 'AC1: a marketing-consented served visit queues one job');
select tests.serve('visit_a');
select is((select count(*)::int from app.integration_jobs), 1, 'an undo and second complete does not queue a second note');

-- visit without a contact
select tests.serve('visit_b');
select is((select count(*)::int from app.integration_jobs where visit_id = tests.id('visit_b')), 0, 'a visit with no contact queues nothing');

-- unverified contact, auto-closed visit
update app.guest_contacts set verified_at = null where id = tests.id('contact_a');
select is((select count(*)::int from private.integration_contact(tests.id('org_a'), tests.id('visit_a'))), 0, 'an unverified contact is not synced');
update app.guest_contacts set verified_at = now() where id = tests.id('contact_a');
delete from app.integration_jobs;
insert into app.visit_events (org_id, visit_id, type, to_status, actor_kind, payload)
values (tests.id('org_a'), tests.id('visit_a'), 'complete', 'served', 'system', '{"auto_closed": true}');
select is((select count(*)::int from app.integration_jobs), 0, 'a day-end auto-close queues nothing');

-- suppression
insert into app.suppressions (org_id, channel, value, reason) values (tests.id('org_a'), 'whatsapp', '+14155550123', 'stop');
select is((select count(*)::int from private.integration_contact(tests.id('org_a'), tests.id('visit_a'))), 0, 'a whatsapp suppression blocks a phone contact');
delete from app.suppressions where value = '+14155550123';
insert into app.suppressions (org_id, channel, value, reason) values (tests.id('org_a'), 'sms', '+14155550123', 'stop');
select is((select count(*)::int from private.integration_contact(tests.id('org_a'), tests.id('visit_a'))), 0, 'a suppressed address is not synced');
delete from app.suppressions where value = '+14155550123';

-- disabled connection
update app.provider_settings set enabled = false where id = tests.id('integration_setting_a');
delete from app.integration_jobs;
select tests.serve('visit_a');
select is((select count(*)::int from app.integration_jobs), 0, 'a disabled connection gets no job');
update app.provider_settings set enabled = true where id = tests.id('integration_setting_a');

-- AC3: another org's connection never receives org A visits, and cannot be tied to a job
insert into app.provider_settings (id, org_id, channel, provider, mode, enabled)
values (tests.new_id('integration_setting_b'), tests.id('org_b'), 'pos', 'square', 'own', true);
select tests.serve('visit_a');
select is((select count(*)::int from app.integration_jobs where setting_id = tests.id('integration_setting_b')), 0, 'AC3: org B''s connection gets no org A job');
select is(tests.error_of(format($$insert into app.integration_jobs (org_id, setting_id, visit_id, event_id) values (%L, %L, %L, 'x')$$,
  tests.id('org_a'), tests.id('integration_setting_b'), tests.id('visit_a'))), '23503 insert or update on table "integration_jobs" violates foreign key constraint "integration_jobs_org_id_setting_id_fkey"',
  'AC3: the schema refuses a job that points at another org''s connection');

-- claim: credentials and the consenting contact, nothing for anon or staff
select tests.act_as('staff');
select is(tests.error_of($$select * from api.claim_integration_jobs(5, 60)$$), '42501 permission denied for function claim_integration_jobs', 'staff cannot claim');
select tests.as_anon();
select is(tests.error_of($$select * from api.claim_integration_jobs(5, 60)$$), '42501 permission denied for function claim_integration_jobs', 'anon cannot claim');

select tests.as_postgres();
update app.provider_settings set secret_ids = jsonb_build_object('access_token', vault.create_secret('tok-a', 'test:integration:tok'))
where id = tests.id('integration_setting_a');
select tests.as_service();
create temp table claimed on commit drop as select * from api.claim_integration_jobs(5, 60);
select is((select count(*)::int from claimed), 1, 'the worker leases the one due job');
select is((select secrets ->> 'access_token' from claimed), 'tok-a', 'with the decrypted token');
select is((select contact ->> 'value' from claimed), '+14155550123', 'and the consenting contact');
select is((select config ->> 'merchant_id' from claimed), 'MA', 'and the connection config');
select is((select count(*)::int from api.claim_integration_jobs(5, 60)), 0, 'a leased job is not handed out twice');

-- consent withdrawn after enqueue: skipped at claim
select tests.as_postgres();
update app.integration_jobs set status = 'queued', locked_until = null;
update app.consents set revoked_at = now(), status = 'revoked' where contact_id = tests.id('contact_a') and purpose = 'marketing';
select tests.as_service();
select is((select count(*)::int from api.claim_integration_jobs(5, 60)), 0, 'a revoked consent returns nothing');
select tests.as_postgres();
select is((select status || ':' || error from app.integration_jobs), 'skipped:no_consent', 'and the job is skipped');

-- report: retry, then dead on the sixth
update app.integration_jobs set status = 'claimed', attempts = 0, locked_until = now() + interval '1 minute', error = null;
select api.report_integration_result((select id from app.integration_jobs), '{"status":"failed","error":"http_500"}');
select is((select status || ':' || attempts from app.integration_jobs), 'failed:1', 'a failure is retried later');
update app.integration_jobs set status = 'claimed', attempts = 5;
select api.report_integration_result((select id from app.integration_jobs), '{"status":"failed","error":"http_500"}');
select is((select status from app.integration_jobs), 'dead', 'the sixth failure dead-letters the job');
update app.integration_jobs set status = 'claimed', attempts = 0;
select api.report_integration_result((select id from app.integration_jobs), '{"status":"delivered"}');
select is((select status from app.integration_jobs), 'delivered', 'delivered is final');

select * from finish();
rollback;
