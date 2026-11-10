-- #251: a Telegram send answered `gone` (the guest blocked the bot) unlinks the chat for good.
begin;
\ir ../helpers/_setup.psql
select plan(3);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_t'), tests.id('org_a'), tests.id('loc_a'), 'Telegram', 'T');
select tests.new_visit('tg_visit', 'queue_t');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_tg'), tests.id('org_a'), tests.id('guest_a'), 'telegram', 'tg:4242', 'online');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version,
                               dedupe_key, status, locked_until)
values (tests.new_id('n_tg'), tests.id('org_a'), tests.id('tg_visit'), 'telegram', tests.id('contact_tg'),
        'almost_up', 1, 'tg1', 'claimed', now() + interval '1 minute');

select lives_ok($$ select api.report_outbox_result(tests.id('n_tg'),
  '{"status": "gone", "provider": "telegram", "error_code": "bot_blocked"}') $$,
  'a gone telegram result is accepted');
select is((select status::text from app.notifications where id = tests.id('n_tg')), 'dead',
  'the message is dead, never retried');
select results_eq($$ select org_id, channel::text, value, reason from app.suppressions where channel = 'telegram' $$,
  $$ values (tests.id('org_a'), 'telegram', 'tg:4242', 'bounce') $$,
  'the chat is suppressed, so later sends to it are suppressed');

select * from finish();
rollback;
