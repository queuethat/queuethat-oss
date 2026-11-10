-- #1132: the platform "needs attention" queue. api.platform_attention ranks tenants that need a human,
-- from rules in private.platform_attention_raw; api.platform_ack_attention snoozes one (org, reason).
-- Roles, MFA, cross-tenant denial, every rule at its threshold, ranking, ack and snooze, audit.
begin;
\ir ../helpers/_setup.psql
select plan(84);
select tests.create_world();

select tests.create_user('support');
insert into app.platform_roles (user_id, role) values (tests.id('support'), 'support');
select tests.create_user('norole');
create function tests.as_operator() returns void
language sql as $$ select tests.as_user(tests.id('platform'), '{"aal":"aal2"}') $$;
create function tests.as_support() returns void
language sql as $$ select tests.as_user(tests.id('support'), '{"aal":"aal2"}') $$;
create function tests.as_support_aal1() returns void
language sql as $$ select tests.as_user(tests.id('support'), '{"aal":"aal1"}') $$;
create function tests.as_norole() returns void
language sql as $$ select tests.as_user(tests.id('norole'), '{"aal":"aal2"}') $$;
grant execute on function tests.as_operator(), tests.as_support(), tests.as_support_aal1(), tests.as_norole()
  to authenticated;

/** Reasons the raw rules report for one org, as text like 'a,b'. */
create function tests.reasons(p_org uuid) returns text
language sql as $$
  select coalesce(string_agg(reason, ',' order by reason), '') from private.platform_attention_raw() where org_id = p_org
$$;

select tests.as_postgres();
update app.platform_flags set billing_enabled = true;
-- loc_a open all day, so "open now" holds whatever the test runs.
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.subscriptions (org_id, status) values (tests.id('org_b'), 'active');

-- ------------------------------------------------------------------ access
select tests.as_anon();
select throws_ok($$select * from api.platform_attention()$$, '42501', null, 'anon cannot read the queue');
select throws_ok($$select api.platform_ack_attention(null, 'plan_limit', 1)$$, '42501', null, 'anon cannot acknowledge');
select tests.as_user(tests.id('owner'), '{"aal":"aal2"}');
select throws_ok($$select * from api.platform_attention()$$, '42501', 'permission_denied', 'a tenant owner cannot read the queue');
select tests.as_norole();
select throws_ok($$select * from api.platform_attention()$$, '42501', 'permission_denied', 'a user with no platform role is refused');
select tests.as_support_aal1();
select throws_ok($$select * from api.platform_attention()$$, '42501', 'permission_denied', 'support without MFA (aal1) is refused');
select throws_ok($$select api.platform_ack_attention(tests.id('org_a'), 'plan_limit', 1)$$, '42501', 'permission_denied', 'acknowledging also needs MFA');
select tests.as_support();
select lives_ok($$select * from api.platform_attention()$$, 'support with aal2 reads the queue');
select throws_ok($$select * from api.platform_attention(0)$$, 'P0001', 'invalid_input', 'limit 0 is refused');
select throws_ok($$select * from api.platform_attention(201)$$, 'P0001', 'invalid_input', 'limit 201 is refused');
select throws_ok($$select * from api.platform_attention(null)$$, 'P0001', 'invalid_input', 'a null limit is refused');
select is((select count(*) from app.platform_attention_acks), 0::bigint, 'support has no table access to acks (only operators read them)');

-- ------------------------------------------------------------------ rules
select tests.as_postgres();
select is(tests.reasons(tests.id('org_a')), 'support_request_open', 'org A: only the fixture support request');
select is(tests.reasons(tests.id('org_b')), '', 'org B: nothing');

-- support_request_open: closed ones do not count; a second open one is counted, since is the oldest.
update app.support_requests set status = 'closed', closed_at = now() where id = tests.id('support_request_a');
select is(tests.reasons(tests.id('org_a')), '', 'a closed support request is not news');
update app.support_requests set status = 'open', closed_at = null where id = tests.id('support_request_a');
select is(tests.reasons(tests.id('org_a')), 'support_request_open', 'reopened: back');

-- payment_past_due
update app.subscriptions set status = 'past_due' where org_id = tests.id('org_b');
select is(tests.reasons(tests.id('org_b')), 'payment_past_due', 'past_due subscription');
update app.subscriptions set status = 'unpaid' where org_id = tests.id('org_b');
select is(tests.reasons(tests.id('org_b')), 'payment_past_due', 'unpaid subscription');
update app.platform_flags set billing_enabled = false;
select is(tests.reasons(tests.id('org_b')), '', 'billing off: nobody is past due');
update app.platform_flags set billing_enabled = true;
update app.subscriptions set status = 'active' where org_id = tests.id('org_b');
select is(tests.reasons(tests.id('org_b')), '', 'active subscription: nothing');

-- sms_auto_paused: an operator's own pause is not news
insert into private.platform_sms_pauses (org_id, state, reason) values (tests.id('org_b'), 'manual', 'by hand');
select is(tests.reasons(tests.id('org_b')), '', 'a manual pause is not flagged');
update private.platform_sms_pauses set state = 'auto', reason = 'stop_rate' where org_id = tests.id('org_b');
select is(tests.reasons(tests.id('org_b')), 'sms_auto_paused', 'an automatic pause is flagged');
update private.platform_sms_pauses set state = 'resumed' where org_id = tests.id('org_b');
select is(tests.reasons(tests.id('org_b')), '', 'resumed: gone');

-- pending_deletion
update app.organizations set status = 'pending_deletion', deletion_requested_at = now(),
  deletion_scheduled_for = now() + interval '30 days' where id = tests.id('org_b');
select is(tests.reasons(tests.id('org_b')), 'pending_deletion', 'pending deletion is flagged');
update app.organizations set status = 'suspended' where id = tests.id('org_b');
select is(tests.reasons(tests.id('org_b')), '', 'merely suspended is not flagged by this rule');
update app.organizations set status = 'active' where id = tests.id('org_b');

-- tagged_attention: only a current note with a churn-risk or billing-issue tag counts
insert into app.platform_org_notes (id, org_id, root_id, version, body, tags)
values (tests.new_id('note1'), tests.id('org_b'), tests.new_id('note1'), 1, 'promised a credit', '{vip}');
select is(tests.reasons(tests.id('org_b')), '', 'a harmless tag is not news');
insert into app.platform_org_notes (id, org_id, root_id, version, body, tags)
values (tests.new_id('note2'), tests.id('org_b'), tests.new_id('note2'), 1, 'may leave', '{churn-risk,vip}');
select is(tests.reasons(tests.id('org_b')), 'tagged_attention', 'churn-risk tag: flagged');
select is((select detail ->> 'tags' from private.platform_attention_raw() where org_id = tests.id('org_b')),
  '["churn-risk"]', 'the detail names the attention tags only');
insert into app.platform_org_notes (id, org_id, root_id, version, body, tags)
values (tests.new_id('note2b'), tests.id('org_b'), tests.new_id('note2'), 2, 'sorted out', '{vip}');
select is(tests.reasons(tests.id('org_b')), '', 'an edit that drops the tag clears it');
select is(tests.reasons(tests.id('org_a')), 'support_request_open', 'other tenants are unaffected');
select is(private.attention_priority('tagged_attention') > private.attention_priority('payment_past_due'), true,
  'a tag ranks below a failing payment');

-- message_failures: 20 attempts and 25% failed is the line; suppressed rows do not count
create function tests.notes(p_sent int, p_failed int, p_suppressed int) returns void
language plpgsql as $$
begin
  delete from app.notifications where org_id = tests.id('org_a');
  insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key, status, created_at)
  select tests.new_id('n' || i), tests.id('org_a'), tests.id('visit_a'), 'email', tests.new_id('c'), 'called', 1, 'n' || i,
         (case when i <= p_sent then 'sent' when i <= p_sent + p_failed then 'failed' else 'suppressed' end)::app.notification_status, now() - interval '1 hour'
  from generate_series(1, p_sent + p_failed + p_suppressed) i;
end $$;
select tests.notes(15, 5, 0);
select is(tests.reasons(tests.id('org_a')), 'message_failures,support_request_open', '5 of 20 failed: flagged');
select tests.notes(16, 4, 0);
select is(tests.reasons(tests.id('org_a')), 'support_request_open', '4 of 20 failed (20%): under the line');
select tests.notes(15, 4, 0);
select is(tests.reasons(tests.id('org_a')), 'support_request_open', '19 attempted: too few to judge');
select tests.notes(15, 5, 40);
select is(tests.reasons(tests.id('org_a')), 'message_failures,support_request_open', 'suppressed rows are neither sent nor failed');
update app.notifications set created_at = now() - interval '25 hours' where org_id = tests.id('org_a');
select is(tests.reasons(tests.id('org_a')), 'support_request_open', 'older than 24 h: out of the window');
delete from app.notifications where org_id = tests.id('org_a');

-- device_offline
insert into app.devices (id, org_id, location_id, kind, name, last_seen_at)
values (tests.new_id('dev_x'), tests.id('org_a'), tests.id('loc_a'), 'display', 'Lobby', now() - interval '2 hours');
select is(tests.reasons(tests.id('org_a')), 'device_offline,support_request_open', 'a display unseen for 2 h in an open location');
update app.devices set last_seen_at = now() - interval '10 minutes' where id = tests.new_id('dev_x');
select is(tests.reasons(tests.id('org_a')), 'support_request_open', 'seen 10 minutes ago: online');
update app.devices set last_seen_at = now() - interval '8 days' where id = tests.new_id('dev_x');
select is(tests.reasons(tests.id('org_a')), 'support_request_open', 'unseen for 8 days: retired, not offline');
update app.devices set last_seen_at = now() - interval '2 hours', revoked_at = now() where id = tests.new_id('dev_x');
select is(tests.reasons(tests.id('org_a')), 'support_request_open', 'a revoked device is ignored');
update app.devices set revoked_at = null where id = tests.new_id('dev_x');
insert into app.hours_exceptions (location_id, org_id, date, closed)
select tests.id('loc_a'), tests.id('org_a'), (now() at time zone l.tz)::date, true from app.locations l where l.id = tests.id('loc_a');
select is(tests.reasons(tests.id('org_a')), 'support_request_open', 'closed today: offline is expected');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
delete from app.devices where id = tests.new_id('dev_x');

-- plan_limit: seats used up, or more locations than allowed
select is((select count(*) from app.memberships where org_id = tests.id('org_a')) >= 4, true, 'precondition: org A has at least 4 members');
insert into app.org_entitlements (org_id, key, value, reason) values (tests.id('org_a'), 'limit.members', to_jsonb(1000), 'test');
select is(tests.reasons(tests.id('org_a')), 'support_request_open', 'plenty of seats left');
update app.org_entitlements set value = to_jsonb((select count(*)::int from app.memberships where org_id = tests.id('org_a')))
  where org_id = tests.id('org_a') and key = 'limit.members';
select is(tests.reasons(tests.id('org_a')), 'plan_limit,support_request_open', 'seats exactly used up: flagged');
update app.org_entitlements set value = to_jsonb(-1) where org_id = tests.id('org_a') and key = 'limit.members';
select is(tests.reasons(tests.id('org_a')), 'support_request_open', 'unlimited (-1): never flagged');
insert into app.org_entitlements (org_id, key, value, reason) values (tests.id('org_a'), 'limit.locations', to_jsonb(1), 'test');
select is(tests.reasons(tests.id('org_a')), 'support_request_open', 'at the location limit is normal, not flagged');
delete from app.org_entitlements where org_id = tests.id('org_a');

-- login_lockout: five wrong codes in the window for a member
insert into private.mfa_failures (user_id) select tests.id('staff') from generate_series(1, 4);
select is(tests.reasons(tests.id('org_a')), 'support_request_open', 'four wrong codes: not locked out');
insert into private.mfa_failures (user_id) values (tests.id('staff'));
select is(tests.reasons(tests.id('org_a')), 'login_lockout,support_request_open', 'five wrong codes: locked out');
select is(tests.reasons(tests.id('org_b')), '', 'the lockout belongs to org A only');
delete from private.mfa_failures;

-- stuck_onboarding: a fresh business stuck at business_created
insert into app.organizations (id, name, created_at) values (tests.new_id('fresh'), 'Fresh Co', now() - interval '2 days');
select is(tests.reasons(tests.new_id('fresh')), '', '2 days at business_created: under the funnel threshold');
update app.organizations set created_at = now() - interval '5 days' where id = tests.new_id('fresh');
select is(tests.reasons(tests.new_id('fresh')), 'stuck_onboarding', '5 days stuck: flagged');
update app.organizations set created_at = now() - interval '45 days' where id = tests.new_id('fresh');
select is(tests.reasons(tests.new_id('fresh')), '', '45 days: abandoned, not today''s work');
update app.organizations set created_at = now() - interval '5 days', status = 'suspended' where id = tests.new_id('fresh');
select is(tests.reasons(tests.new_id('fresh')), '', 'a suspended org is not stuck onboarding');
delete from app.organizations where id = tests.new_id('fresh');

-- no_recent_visits: a live line, quiet for 7 to 30 days
update app.queues set created_at = now() - interval '40 days', archived_at = null, manual_state = 'open' where org_id = tests.id('org_a');
select is(tests.reasons(tests.id('org_a')) like '%no_recent_visits%', false, 'a fresh visit in the world: the line is busy');
update app.visits set joined_at = now() - interval '10 days' where org_id = tests.id('org_a');
select is(tests.reasons(tests.id('org_a')) like '%no_recent_visits%', true, 'live line, last visit 10 days ago: flagged');
update app.visits set joined_at = now() - interval '3 days' where org_id = tests.id('org_a');
select is(tests.reasons(tests.id('org_a')) like '%no_recent_visits%', false, 'last visit 3 days ago: fine');
update app.visits set joined_at = now() - interval '40 days' where org_id = tests.id('org_a');
select is(tests.reasons(tests.id('org_a')) like '%no_recent_visits%', false, 'quiet for 40 days: churned, not today');
update app.visits set joined_at = now() - interval '10 days' where org_id = tests.id('org_a');
update app.queues set manual_state = 'closed' where org_id = tests.id('org_a');
select is(tests.reasons(tests.id('org_a')) like '%no_recent_visits%', false, 'no live line: not "after going live"');
update app.queues set manual_state = 'open' where org_id = tests.id('org_a');

-- ------------------------------------------------------------------ ranking, ack and snooze
-- Org A now: support_request_open, no_recent_visits. Org B: payment_past_due, pending_deletion.
update app.subscriptions set status = 'past_due' where org_id = tests.id('org_b');
update app.organizations set status = 'pending_deletion', deletion_requested_at = now() where id = tests.id('org_b');
select tests.as_support();
create temp table q as select * from api.platform_attention(50);
select tests.as_postgres();
select is((select string_agg(org_id || ':' || reason, ' ' order by priority, since, org_id) from q),
  (select string_agg(x, ' ') from (
     select org_id || ':' || reason as x from q order by priority, since, org_id) y), 'rows come back in priority order');
select is((select array_agg(reason order by priority) from q where org_id = tests.id('org_b')),
  array['payment_past_due', 'pending_deletion'], 'org B: payment before deletion');
select is((select min(priority) from q where reason = 'support_request_open') < (select min(priority) from q where reason = 'no_recent_visits'),
  true, 'a human asking for help outranks a quiet line');
select is((select reason from q limit 1), 'support_request_open', 'first row is the most urgent');
select is((select count(distinct total) from q), 1::bigint, 'total is the same on every row');
select is((select max(total) from q), (select count(*)::int from q), 'total counts every open item');
select is((select name from q where org_id = tests.id('org_b') limit 1), (select name from app.organizations where id = tests.id('org_b')), 'rows carry the org name');

select tests.as_support();
select is((select count(*) from api.platform_attention(1)), 1::bigint, 'p_limit caps the rows');
select is((select total from api.platform_attention(1)), (select max(total) from q), 'total ignores p_limit');

-- ack hides one (org, reason) only
select lives_ok($$select api.platform_ack_attention(tests.id('org_a'), 'support_request_open', 24)$$, 'support acknowledges');
select is((select count(*) from api.platform_attention(50) where org_id = tests.id('org_a') and reason = 'support_request_open'), 0::bigint,
  'the acknowledged item is hidden');
select is((select count(*) from api.platform_attention(50) where org_id = tests.id('org_a') and reason = 'no_recent_visits'), 1::bigint,
  'another reason of the same org still shows');
select is((select count(*) from api.platform_attention(50) where org_id = tests.id('org_b')), 2::bigint, 'another org is unaffected');
select tests.as_operator();
select is((select acked_by from app.platform_attention_acks where org_id = tests.id('org_a') and reason = 'support_request_open'),
  tests.id('support'), 'the ack records who');
select tests.as_postgres();
select is((select count(*) from app.platform_audit where action = 'attention.ack' and org_id = tests.id('org_a')
           and target = '{"reason":"support_request_open","hours":24}'::jsonb and actor_id = tests.id('support')), 1::bigint, 'the ack is audited');
-- the snooze ends
update app.platform_attention_acks set snooze_until = now() - interval '1 second'
  where org_id = tests.id('org_a') and reason = 'support_request_open';
select tests.as_support();
select is((select count(*) from api.platform_attention(50) where org_id = tests.id('org_a') and reason = 'support_request_open'), 1::bigint,
  'an expired snooze shows the item again');
-- acknowledging again restarts it; a longer one replaces the older
select api.platform_ack_attention(tests.id('org_a'), 'support_request_open', 1);
select api.platform_ack_attention(tests.id('org_a'), 'support_request_open', 720);
select tests.as_postgres();
select is((select count(*) from app.platform_attention_acks where org_id = tests.id('org_a') and reason = 'support_request_open'), 1::bigint, 'one row per (org, reason)');
select is((select snooze_until > now() + interval '719 hours' from app.platform_attention_acks
           where org_id = tests.id('org_a') and reason = 'support_request_open'), true, 'the latest snooze wins');
-- 0 hours shows it again, and repeating it is a no-op
select tests.as_support();
select api.platform_ack_attention(tests.id('org_a'), 'support_request_open', 0);
select api.platform_ack_attention(tests.id('org_a'), 'support_request_open', 0);
select is((select count(*) from api.platform_attention(50) where org_id = tests.id('org_a') and reason = 'support_request_open'), 1::bigint, 'un-snoozed');
select tests.as_postgres();
select is((select count(*) from app.platform_audit where action = 'attention.unack' and org_id = tests.id('org_a')), 1::bigint, 'only the real un-snooze is audited');
-- a reason that has gone away simply disappears; a new reason is a new item
update app.support_requests set status = 'closed', closed_at = now() where org_id = tests.id('org_a');
select tests.as_support();
select is((select count(*) from api.platform_attention(50) where org_id = tests.id('org_a') and reason = 'support_request_open'), 0::bigint, 'resolved: gone');

-- validation
select throws_ok($$select api.platform_ack_attention(tests.id('org_a'), 'made_up', 1)$$, 'P0001', 'invalid_input', 'unknown reason');
select throws_ok($$select api.platform_ack_attention(tests.id('org_a'), null, 1)$$, 'P0001', 'invalid_input', 'null reason');
select throws_ok($$select api.platform_ack_attention(tests.id('org_a'), 'plan_limit', 721)$$, 'P0001', 'invalid_input', '721 hours');
select throws_ok($$select api.platform_ack_attention(tests.id('org_a'), 'plan_limit', -1)$$, 'P0001', 'invalid_input', 'negative hours');
select throws_ok($$select api.platform_ack_attention(tests.id('org_a'), 'plan_limit', null)$$, 'P0001', 'invalid_input', 'null hours');
select throws_ok($$select api.platform_ack_attention(gen_random_uuid(), 'plan_limit', 1)$$, 'P0001', 'not_found', 'unknown org');

select * from finish();
rollback;
