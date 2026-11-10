-- S5 (#26): who may call each api.* function, and that every one documents its interface.
begin;
\ir ../helpers/_setup.psql
select plan(9);

select set_eq(
  $$ select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api' and has_function_privilege('anon', p.oid, 'EXECUTE') $$,
  array['get_location_public', 'join_queue', 'get_visit_status', 'guest_act', 'guest_register_push',
        'get_visit_info', 'get_location_wait', 'guest_get_alert_prefs', 'guest_set_alert_prefs',
        'get_available_slots', 'book_appointment', 'get_location_branding',
        'get_appointment', 'guest_cancel_appointment', 'guest_reschedule_appointment',
        'guest_register_appointment_push', 'guest_add_companion', 'guest_remove_companion',
        'guest_submit_feedback', 'guest_send_message', 'guest_list_messages', 'guest_create_link_code',
        'guest_claim_offer', 'guest_leave_waitlist', 'book_event_seats', 'guest_join_waitlist',
        'get_location_events', 'guest_get_waitlist', 'guest_grant_consent', 'guest_verify_phone_code', 'get_join_form',
        'set_booking_answers', 'get_location_lines'],
  'anon can execute exactly the thirty-three guest functions');

select set_eq(
  $$ select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api' and not has_function_privilege('authenticated', p.oid, 'EXECUTE') $$,
  array['claim_outbox', 'health_report', 'outbox_still_relevant', 'report_outbox_result',
        'redeem_pairing_code', 'register_device', 'unsubscribe_outbox', 'issue_join_pass', 'hit_rate_limit', 'calendar_feed_events', 'org_purge_targets', 'mark_org_purged_externally',
        'dev_record_inbound', 'redeem_link_code', 'unlink_telegram_chat', 'process_telegram_message', 'process_voice_call', 'create_payment_hold', 'record_payment_event', 'claim_webhook_deliveries', 'report_webhook_result',
        'record_webhook_event', 'mark_webhook_processed', 'process_inbound_message', 'get_channel_config',
        'get_webhook_secret', 'reserve_send', 'get_whatsapp_send', 'claim_payment_jobs', 'report_payment_result', 'apply_payment_event', 'begin_payment', 'begin_pos_payment', 'begin_pos_payment_by_code', 'attach_payment_intent', 'resolve_custom_domain', 'record_domain_check',
        'apply_delivery_status', 'pending_price_reconciliation', 'apply_provider_price', 'suppress_by_message', 'apply_platform_sms_event', 'guest_request_phone_code', 'claim_billing_jobs', 'report_billing_result', 'apply_billing_event', 'apply_credit_topup', 'apply_bundle_grant',
        'claim_integration_jobs', 'report_integration_result', 'consume_integration_state', 'save_integration_tokens', 'revoke_integration',
        'platform_revoke_role'],
  'only the dispatcher, health, pair-device, unsubscribe, join-pass, public-join, calendar-feed, purge-org, dev-simulator, link-code, webhook-delivery, provider-webhook, dispatcher-limit, payment-job, billing, domain-check and delivery-status functions are closed to signed-in users');

select is_empty(
  $$ select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api' and coalesce(obj_description(p.oid, 'pg_proc'), '') = '' $$,
  'every api function has a COMMENT describing its interface');

select ok(not has_function_privilege('authenticated', 'ops.rollover_tick()', 'EXECUTE')
          and not has_function_privilege('anon', 'ops.rollover_tick()', 'EXECUTE'),
  'ops.rollover_tick is not callable through the API');

select tests.as_anon();
select throws_ok($$ select api.call_next(gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) $$,
  '42501', null, 'anon cannot call a staff function');
select throws_ok($$ select api.get_visit_status('token') $$,
  'P0001', 'not_found', 'anon reaches get_visit_status');

select tests.as_postgres();
select is(private.allowed_actions('waiting'),
  array['call', 'no_show', 'cancel', 'remove']::api.visit_action[],
  'allowed actions for waiting come from visit_transitions, without system-only expire');
select is(private.allowed_actions('served'), '{}'::api.visit_action[],
  'a served visit allows nothing');
select is(private.guest_actions('called'), array['leave', 'on_my_way', 'need_more_time']::api.guest_action[],
  'a called guest can still leave, and say they are on the way or ask for more time');

select * from finish();
rollback;
