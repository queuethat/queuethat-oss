-- C6 (#1272): intake answers never reach outbound content or logs (I-5, I-11, I-13).
--
-- Two kinds of proof:
--  1. Structure. Which code and which tables can touch an answer is pinned, so a new reader fails
--     here until someone has looked at where its output goes.
--  2. Canary. Distinctive answer values go through a join, a staff edit and every visit transition
--     with every outbound channel switched on; then every table the system can write to, and the
--     payload of every claim function an Edge Function sends from, is searched for them.
-- The places a canary may appear are app.visit_answers and its F2 mirror app.form_responses (form_versions
-- holds the form's options, configuration like intake_fields) (a positive control proves the
-- search can see it). The Edge Function half is scripts/check-answers-not-in-outbound.mjs.
begin;
\ir ../helpers/_setup.psql
select plan(24);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();
select tests.new_id(k) from unnest(array['k1', 'k2', 'k3']) k;

update app.locations set tz = (select name from pg_timezone_names
  where extract(hour from now() at time zone name) = 12 and name !~ '^(posix|Etc|SystemV)' limit 1);
delete from app.business_hours;
delete from app.hours_exceptions;
delete from app.visit_answers;
delete from app.intake_fields;
update app.queues set notify_triggers = '{joined,called,almost_up,position_changed,eta_changed,no_show_warning,removed,served}'
where id = tests.id('queue_a');
insert into app.intake_fields (org_id, location_id, queue_id, key, label, type, options, visibility, position) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'reason', 'Reason', 'select', '["zzcanaryoptionzz","other"]', 'guest', 1),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'note', 'Note', 'text', null, 'guest', 2),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'mobile', 'Mobile', 'phone', null, 'guest', 3),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'age', 'Age', 'number', null, 'guest', 4),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'since', 'Since', 'date', null, 'guest', 5),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('queue_a'), 'triage', 'Triage', 'text', null, 'staff_only', 6);

create table tests.canaries (label text primary key, needle text not null);
insert into tests.canaries values
  ('select', 'zzcanaryoptionzz'),
  ('text', 'CANARYNOTE7f3a91'),
  ('phone', '+14155550913'),
  ('number', '31415926535'),
  ('date', '1987-06-05'),
  ('staff_only', 'CANARYTRIAGE5c8e02');
grant select on tests.canaries to anon, authenticated, service_role;

/** Tables where any canary shows up as a row value (JSON text of the whole row). */
create function tests.leaking_tables() returns setof text
language plpgsql as $$
declare t record; n int;
begin
  for t in select schemaname s, tablename r from pg_tables
           where schemaname in ('app', 'private', 'net', 'cron') and tablename not in ('visit_answers', 'intake_fields', 'form_responses', 'form_versions') loop
    -- An intake form's own options are configuration, not answers (and the audit log records them).
    execute format('select count(*) from %I.%I x where to_jsonb(x)::text ~ (select string_agg(regexp_replace(needle, ''([+.])'', ''\\\1'', ''g''), ''|'') from tests.canaries)'
                   || case when t.r = 'audit_log' then ' and x.table_name <> ''intake_fields''' else '' end,
                   t.s, t.r) into n;
    if n > 0 then return next t.s || '.' || t.r; end if;
  end loop;
end $$;

create function tests.vid(p_name text) returns uuid language plpgsql stable as $$
begin return (select visit_id from tests.join_out where name = p_name); end $$;
grant execute on function tests.vid(text) to authenticated, service_role, anon;

/** Current version of a visit, for a staff caller who cannot read app.visits directly. */
create function tests.ver(p_name text) returns int language plpgsql security definer set search_path = '' as $$
begin return (select version from app.visits where id = tests.vid(p_name)); end $$;
grant execute on function tests.ver(text) to authenticated;

/** True when the text carries any canary. */
create function tests.has_canary(p_text text) returns boolean
language sql stable as $$ select exists (select 1 from tests.canaries where position(needle in p_text) > 0) $$;
grant execute on function tests.has_canary(text) to authenticated, service_role, anon;

------------------------------------------------------------------------------------------------
-- 1. Structure
------------------------------------------------------------------------------------------------
-- A deletion reads no value, so it is stripped before looking for readers and writers.
select is((select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('api', 'api_v1', 'app', 'private', 'public')
             and regexp_replace(p.prosrc, 'delete\s+from\s+app\.(visit_answers|form_responses)', '', 'gi') ~* '(visit_answers|form_responses)'),
  array['api.get_visit_answers', 'api.set_booking_answers', 'api.set_visit_answers', 'private.carry_booking_answers', 'private.export_guest_answers', 'private.join_core'],
  'C6: only the answer writers (join_core, set_visit_answers, set_booking_answers), carry_booking_answers (copies a booking''s answers to its visit row), the audited staff read (get_visit_answers, F7) and the audited admin per-guest export (export_guest_answers, #1311) touch the answers table; nothing else reads it server-side');
select is((select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('api', 'api_v1', 'app', 'private', 'public')
             and p.prosrc ~* 'delete\s+from\s+app\.(visit_answers|form_responses)'),
  array['api.set_visit_answers', 'private.anonymize_appointments', 'private.anonymize_visits', 'private.carry_booking_answers'],
  'C6: the only functions that delete answers are a staff clearing them, the retention purges and the booking carry (empties the mirror)');
select is((select count(*)::int from pg_views v where v.schemaname in ('api', 'api_v1', 'app', 'private', 'public')
           and v.definition ~* '(visit_answers|form_responses)'), 0, 'C6: no view exposes answers');
select is((select count(*)::int from pg_matviews v where v.definition ~* '(visit_answers|form_responses)'), 0, 'C6: no materialized view copies answers');
select is((select array_agg(tgname::text order by tgname) from pg_trigger
           where tgrelid = 'app.visit_answers'::regclass and not tgisinternal),
  array['forbid_org_change', 'touch_updated_at'],
  'C6: no audit or event trigger copies answers out of their table');
select is((select count(*)::int from pg_publication_tables where schemaname = 'app' and tablename = 'visit_answers'),
  0, 'C6 (I-5): answers are not in any Realtime publication');
select is((select count(*)::int from information_schema.role_table_grants
           where table_schema = 'app' and table_name = 'visit_answers' and grantee in ('anon', 'public', 'PUBLIC')),
  0, 'C6 (I-4): anon has no access to answers');
select is((select count(*)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where not t.tgisinternal and c.relname in ('visits', 'visit_events')
             and pg_get_triggerdef(t.oid) ~* 'visit_answers'), 0, 'C6: visit triggers do not reference answers');

------------------------------------------------------------------------------------------------
-- 2. Canary: drive every outbound path
------------------------------------------------------------------------------------------------
-- Outbound switches on: a webhook endpoint (with and without guest data), a push subscription and
-- a consented email contact, so notifications, deliveries and integration jobs are really enqueued.
create table tests.ep (name text primary key, id uuid);
grant all on tests.ep to authenticated, service_role;
select tests.act_as('admin');
insert into tests.ep select 'plain', e.id from api.create_webhook_endpoint(tests.id('org_a'), 'https://example.com/plain', 'generic',
  array['visit.joined', 'visit.called', 'visit.served', 'visit.removed', 'visit.no_show', 'queue.state_changed'], false, gen_random_uuid()) e;
insert into tests.ep select 'guest', e.id from api.create_webhook_endpoint(tests.id('org_a'), 'https://example.com/guest', 'generic',
  array['visit.joined', 'visit.called', 'visit.served', 'visit.removed', 'visit.no_show'], true, gen_random_uuid()) e;
select tests.as_postgres();

create table tests.join_out (name text primary key, visit_id uuid, token text);
grant all on tests.join_out to anon, authenticated, service_role;
select tests.as_anon();
select set_config('request.headers', '{"x-real-ip": "198.51.100.77"}', true);
insert into tests.join_out
select 'v' || i, null, j.token from generate_series(1, 3) i, lateral (select * from api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'Pat Guest',
  p_phone_e164 => '+14155550100', p_email => 'pat' || i || '@example.com', p_party_size => 1, p_locale => null,
  p_idempotency_key => tests.id('k' || i),
  p_answers => '{"reason":"zzcanaryoptionzz","note":"CANARYNOTE7f3a91","mobile":"+1 (415) 555-0913","age":31415926535,"since":"1987-06-05"}'::jsonb)) j;
select tests.as_postgres();
update tests.join_out j set visit_id = (select v.id from app.visits v where v.idempotency_key = tests.id('k' || right(j.name, 1)));
insert into app.push_subscriptions (org_id, visit_id, endpoint, p256dh, auth)
select org_id, id, 'https://push.example/' || id, 'k', 'a' from app.visits where id in (tests.vid('v1'), tests.vid('v2'), tests.vid('v3'));

select is((select count(*)::int from app.visit_answers where answers::text like '%CANARYNOTE7f3a91%'), 3,
  'positive control: the joins stored the answers in app.visit_answers');
select tests.act_as('staff');
select api.set_visit_answers(tests.vid('v1'), '{"triage":"CANARYTRIAGE5c8e02","note":"CANARYNOTE7f3a91"}',
  tests.ver('v1'), gen_random_uuid());
select api.transition_visit(tests.vid('v1'), 'call', tests.ver('v1'), gen_random_uuid());
select api.transition_visit(tests.vid('v1'), 'start', tests.ver('v1'), gen_random_uuid());
select api.transition_visit(tests.vid('v1'), 'complete', tests.ver('v1'), gen_random_uuid());
select api.transition_visit(tests.vid('v2'), 'remove', tests.ver('v2'), gen_random_uuid(), null, 'test');
select api.transition_visit(tests.vid('v3'), 'call', tests.ver('v3'), gen_random_uuid());
select api.transition_visit(tests.vid('v3'), 'no_show', tests.ver('v3'), gen_random_uuid());
select tests.as_postgres();

select cmp_ok((select count(*)::int from app.notifications where visit_id in (tests.vid('v1'), tests.vid('v2'), tests.vid('v3'))), '>=', 4,
  'positive control: the lifecycle enqueued notifications to search');
select cmp_ok((select count(*)::int from app.webhook_deliveries where payload::text like '%visit.%' or event_type like 'visit.%'), '>=', 4,
  'positive control: the lifecycle queued webhook deliveries to search');
select cmp_ok((select count(*)::int from app.visit_events where visit_id in (tests.vid('v1'), tests.vid('v2'), tests.vid('v3'))), '>=', 9,
  'positive control: the lifecycle wrote visit events to search');

-- Every stored row: notifications (vars), webhook_deliveries (payload), visit_events, audit_log,
-- idempotency_keys, join_log, integration_jobs, pg_net's queue, cron history, and the rest.
select is((select array_agg(x) from tests.leaking_tables() x), null::text[],
  'AC: no answer value appears in any table other than app.visit_answers (outbox, deliveries, events, audit, idempotency, net queue)');

-- The sweep itself works: a canary planted in a table it reads is found, then removed.
insert into app.audit_log (org_id, action, table_name, after) values (tests.id('org_a'), 'UPDATE', 'visits', '{"x":"CANARYNOTE7f3a91"}');
select is((select array_agg(x) from tests.leaking_tables() x), array['app.audit_log'], 'negative control: the sweep finds a canary planted in the audit log');
delete from app.audit_log where after = '{"x":"CANARYNOTE7f3a91"}';

-- Everything an Edge Function claims to send, as the service role.
create table tests.claimed (what text, body text);
grant all on tests.claimed to service_role;
select tests.as_service();
insert into tests.claimed select 'outbox', to_jsonb(c)::text from api.claim_outbox(100, 60) c;
insert into tests.claimed select 'webhooks', to_jsonb(c)::text from api.claim_webhook_deliveries(100, 60) c;
insert into tests.claimed select 'integrations', to_jsonb(c)::text from api.claim_integration_jobs(100, 60) c;
insert into tests.claimed select 'payments', to_jsonb(c)::text from api.claim_payment_jobs(100, 60) c;
select tests.as_postgres();
select cmp_ok((select count(*)::int from tests.claimed where what = 'outbox'), '>=', 1, 'positive control: the dispatcher claimed jobs');
select cmp_ok((select count(*)::int from tests.claimed where what = 'webhooks'), '>=', 1, 'positive control: the webhook sender claimed deliveries');
select is((select count(*)::int from tests.claimed where tests.has_canary(body)), 0,
  'AC: nothing a sender claims (SMS, email, push, webhook body, integration job) carries an answer');
select is((select count(*)::int from tests.claimed where what = 'webhooks' and body ~ 'guest_first_name": "Pat"') > 0, true,
  'positive control: the opt-in endpoint does carry the guest first name, so a leak of answers would be visible there');

-- What the guest sees and what the guest-facing and public APIs return.
select tests.as_anon();
select is((select tests.has_canary(to_jsonb(s)::text) from api.get_visit_status((select token from tests.join_out where name = 'v1')) s limit 1),
  false, 'AC: the guest status page carries no answers');
-- #1311: v1 belongs to a known guest so the per-guest export can be asked for it.
select tests.as_postgres();
insert into app.guests (id, org_id, first_name) values (tests.new_id('guest_pat'), tests.id('org_a'), 'Pat');
select private.set_actor('system', null);
update app.visits set guest_id = tests.id('guest_pat') where id = tests.vid('v1');
select tests.act_as('admin');
select is((select count(*)::int from api.export_guests(tests.id('org_a')) g where tests.has_canary(to_jsonb(g)::text)), 0,
  'AC: the guest CSV export carries no answers');
-- #1311: the guest's own export holds the guest's own answers (right of access); any other guest's export holds none.
select is((select tests.has_canary(to_jsonb(e)::text) from api.export_guest_data(tests.id('guest_pat')) e),
  true, 'AC (#1311): the per-guest data export holds that guest''s own answers');
select is((select tests.has_canary(to_jsonb(e)::text) from api.export_guest_data(tests.id('guest_a')) e),
  false, 'AC (#1311): the per-guest data export contains only that guest''s answers');
select tests.as_postgres();
select is((select count(*)::int from app.visit_events e where tests.has_canary(to_jsonb(e)::text)), 0,
  'AC: visit events (the feed behind webhooks and exports) carry no answers');
select is((select count(*)::int from app.audit_log a where a.table_name <> 'intake_fields' and tests.has_canary(to_jsonb(a)::text)), 0,
  'AC: the audit log, which the org export includes, carries no answers');

select * from finish();
rollback;
