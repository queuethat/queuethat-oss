-- 3-EM2 (#348): bounces and complaints suppress the org's own recipient.
begin;
\ir ../helpers/_setup.psql
select plan(8);
select tests.create_world();

alter table app.visit_events disable trigger enqueue_notifications;
select private.set_actor('system', null);
update app.visits set guest_email = 'lee+q@example.com' where id = tests.id('visit_a');
alter table app.visit_events enable trigger enqueue_notifications;
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version,
                               dedupe_key, status, provider, provider_message_id)
values (tests.new_id('e1'), tests.id('org_a'), tests.id('visit_a'), 'email', tests.id('visit_a'), 'called', 1, 'e1',
        'sent', 'resend', 'em_1'),
       (tests.new_id('e2'), tests.id('org_a'), tests.id('visit_a'), 'email', tests.id('visit_a'), 'called', 1, 'e2',
        'sent', 'postmark', 'pm_1');
select tests.as_service();

select ok(api.suppress_by_message(tests.id('org_a'), 'resend', 'em_1', 'complaint'), 'AC1: a complaint is applied');
select ok(api.suppress_by_message(tests.id('org_a'), 'resend', 'em_1', 'complaint'), 'a repeat is a no-op');
select tests.as_postgres();
select results_eq($$ select org_id, channel::text, value, reason from app.suppressions where value like 'lee%' $$,
  $$ values (tests.id('org_a'), 'email', private.canonical_email('lee+q@example.com'), 'stop') $$,
  'AC1: the canonical address is suppressed for the org only (reason stop, never platform-wide)');
select is((select count(*)::int from app.suppressions where value like 'lee%'), 1, 'exactly one suppression for the address');

-- Later sends are held back: the next claim reports the address as suppressed.
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
values (tests.new_id('e3'), tests.id('org_a'), tests.id('visit_a'), 'email', tests.id('visit_a'), 'called', 1, 'e3');
select is((select j.is_suppressed from api.claim_outbox(200, 60) j where j.id = tests.new_id('e3')), true,
  'AC1: a later send to that address is suppressed');

select tests.as_service();
-- AC3: another org's endpoint cannot suppress org A's recipient.
select ok(not api.suppress_by_message(tests.id('org_b'), 'postmark', 'pm_1', 'bounce'), 'another org matches nothing');
select tests.as_postgres();
select is((select count(*)::int from app.suppressions where reason in ('bounce', 'complaint')), 0, 'and nothing was written');
select tests.as_service();
select throws_ok($$ select api.suppress_by_message(tests.id('org_a'), 'postmark', 'pm_1', 'stop') $$, 'P0001', 'invalid_input',
  'only bounce and complaint are accepted');

select * from finish();
rollback;
