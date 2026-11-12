-- Extension hooks, part 3: the paid-send path. Each hook does nothing here, and a deployment that
-- replaces its body refuses or records sends at that one point.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();

update app.organizations set created_at = now() - interval '60 days';
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('sp'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550199', 'online');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
select tests.new_id(k), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('sp'), 'called', 1, k
from unnest(array['s1', 's2', 's3']) k;

-- ------------------------------------------------------------------ contract
select function_returns('private', 'ext_send_refusal', array['uuid', 'text', 'boolean'], 'text',
  'ext_send_refusal(uuid, text, boolean) returns text');
select function_returns('private', 'ext_send_reported', array['uuid', 'uuid', 'text', 'text', 'bigint', 'integer'], 'void',
  'ext_send_reported(uuid, uuid, text, text, bigint, integer) returns void');

-- ------------------------------------------------------------------ reserve_send
select tests.as_service();
select is((api.reserve_send(tests.id('s1'))).decision, 'allowed', 'here a paid send is reserved as before');

select tests.as_postgres();
create or replace function private.ext_send_refusal(p_org_id uuid, p_channel text, p_reserved boolean) returns text
language sql stable set search_path = '' as $$
  select case when p_org_id = tests.id('org_a') and p_channel = 'sms' and not p_reserved then 'insufficient_credit' end
$$;
select tests.as_service();
select is((api.reserve_send(tests.id('s2'))).decision, 'insufficient_credit', 'a deployment refusal becomes the decision');
select tests.as_postgres();
select is((select reserved_at from app.notifications where id = tests.id('s2')), null, 'and the send is not reserved');
select is((select sent from app.usage_counters where org_id = tests.id('org_a') and channel = 'sms'
           and day = (now() at time zone 'UTC')::date), 1, 'or counted');
select tests.as_service();
select is((api.reserve_send(tests.id('s1'))).decision, 'allowed',
  'the hook is told about an earlier reservation, so a retry can go through');

select tests.as_postgres();
create or replace function private.ext_send_refusal(p_org_id uuid, p_channel text, p_reserved boolean) returns text
language sql stable set search_path = '' as $$ select 'Out of credit!' $$;
select tests.as_service();
select is((api.reserve_send(tests.id('s2'))).decision, 'refused', 'a refusal that is not a short code is stored as refused');
select tests.as_postgres();
create or replace function private.ext_send_refusal(p_org_id uuid, p_channel text, p_reserved boolean) returns text
language sql stable set search_path = '' as $$ select 'quiet_hours' $$;
select tests.as_service();
select is((api.reserve_send(tests.id('s2'))).decision, 'refused', 'and so is quiet_hours, which the outbox would requeue');

-- ------------------------------------------------------------------ report_outbox_result
select tests.as_postgres();
create table tests.reported (id uuid, status text, cost bigint, segments int);
create or replace function private.ext_send_reported(p_notification_id uuid, p_org_id uuid, p_channel text,
  p_status text, p_cost_micros bigint, p_segments int) returns void
language sql volatile set search_path = '' as $$
  insert into tests.reported values (p_notification_id, p_status, p_cost_micros, p_segments)
$$;
update app.notifications set status = 'claimed' where id = tests.id('s1');
select tests.as_service();
select api.report_outbox_result(tests.id('s1'), '{"status": "sent", "provider": "twilio", "cost_micros": 7900, "segments": 2}');
select tests.as_postgres();
select results_eq($$ select id, status, cost, segments from tests.reported $$,
  $$ values (tests.id('s1'), 'sent', 7900::bigint, 2) $$, 'a finished send reaches the hook with what was recorded');

select tests.as_service();
select api.report_outbox_result(tests.id('s1'), '{"status": "sent", "provider": "twilio", "cost_micros": 7900}');
select tests.as_postgres();
select is((select count(*)::int from tests.reported), 1, 'a report for a row no longer claimed does not reach it');

create or replace function private.ext_send_reported(p_notification_id uuid, p_org_id uuid, p_channel text,
  p_status text, p_cost_micros bigint, p_segments int) returns void
language plpgsql volatile set search_path = '' as $$ begin raise exception 'hook_failed'; end $$;
update app.notifications set status = 'claimed' where id = tests.id('s3');
select tests.as_service();
select throws_ok($$ select api.report_outbox_result(tests.id('s3'), '{"status": "sent", "provider": "twilio", "cost_micros": 7900}') $$,
  'hook_failed', 'an error in the hook fails the report');
select tests.as_postgres();
select is((select status::text from app.notifications where id = tests.id('s3')), 'claimed',
  'and the row stays claimed, to be reported again');

select * from finish();
rollback;
