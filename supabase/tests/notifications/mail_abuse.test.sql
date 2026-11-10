-- Security review of #468: limits on mail to an address typed at join.
begin;
\ir ../helpers/_setup.psql
select plan(8);
select tests.create_world();
-- Claims defer non-urgent mail outside the send window (3-CG9); keep these tests independent of the wall clock.
update app.locations set tz = (select name from pg_timezone_names where extract(hour from now() at time zone name) = 12 and name !~ '^(posix|Etc|SystemV)' limit 1);

insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_v'), tests.id('org_a'), tests.id('loc_a'), 'Abuse A', 'V'),
  (tests.new_id('queue_w'), tests.id('org_b'), tests.id('loc_b'), 'Abuse B', 'W');
select tests.new_visit(n, 'queue_v') from unnest(array['first', 'second', 'third']) n;
select tests.new_visit('other_org', 'queue_w');
alter table app.visit_events disable trigger enqueue_notifications;
select private.set_actor('system', null);
update app.visits set guest_email = 'victim@example.com',
                      joined_at = now() - interval '1 minute' * (10 - sort_key / 1024)
where id in (tests.id('first'), tests.id('third'), tests.id('other_org'));
-- A +tag reaches the same inbox, so it counts as the same address.
update app.visits set guest_email = 'victim+2@example.com', joined_at = now() - interval '8 minutes'
where id = tests.id('second');
alter table app.visit_events enable trigger enqueue_notifications;

select private.set_actor('staff', tests.id('staff'), 'call');
update app.visits set status = 'called' where id in (tests.id('first'), tests.id('second'), tests.id('third'));
select private.set_actor('staff', tests.id('other_owner'), 'call');
update app.visits set status = 'called' where id = tests.id('other_org');
select results_eq($$ select visit_id from app.notifications
                     where template_key = 'called' and channel = 'email' order by visit_id $$,
  $$ select v from unnest(array[tests.id('first'), tests.id('other_org')]) v order by v $$,
  'repeated joins with one address or its +tag variants mail only the org''s earliest live visit, and another org still mails its own');

-- Once the first visit is over, the next live visit with the address is the earliest one.
select private.set_actor('staff', tests.id('staff'), 'no_show');
update app.visits set status = 'no_show' where id = tests.id('first');
select tests.act_as('staff');
select api.transition_visit(tests.id('second'), 'recall', (select version from app.visits where id = tests.id('second')),
                            gen_random_uuid());
select tests.as_postgres();
select is((select count(*)::int from app.notifications where visit_id = tests.id('second') and template_key = 'called'), 1,
  'after the earlier visit ends, the next visit with the address is mailed');

-- Platform-wide cap: twenty guest messages already sent to the address today, in another org.
create table tests.jobs of api.outbox_job;
insert into tests.jobs select * from api.claim_outbox(50, 60);
select isnt((select recipient_hash from app.notifications where visit_id = tests.id('first') and template_key = 'called'),
  null, 'a claimed guest email records the address hash');
select is((select is_suppressed from tests.jobs where visit_id = tests.id('first') and template_key = 'called'), false,
  'under the cap the address is not suppressed');
update app.notifications set status = 'queued', next_attempt_at = now(), locked_until = null
where visit_id = tests.id('second');
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version,
                               dedupe_key, status, recipient_hash)
select tests.id('org_b'), tests.id('other_org'), 'email', tests.id('other_org'), 'called', 1, 'cap' || i, 'sent',
       encode(sha256(convert_to('victim@example.com', 'UTF8')), 'hex')
from generate_series(1, private.address_daily_cap()) i;
select is((select is_suppressed from api.claim_outbox(50, 60) where visit_id = tests.id('second')), true,
  'at the daily cap, counted across orgs and address variants, the address is suppressed');

-- Bounces and complaints suppress the address, in every org.
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
values (tests.new_id('n_bounce'), tests.id('org_b'), tests.id('other_org'), 'email', tests.id('other_org'),
        'almost_up', 1, 'bounce'),
       (tests.new_id('n_complaint'), tests.id('org_a'), tests.id('third'), 'email', tests.id('third'),
        'almost_up', 1, 'complaint');
update app.visits set guest_email = 'grumpy@example.com' where id = tests.id('third');
select api.claim_outbox(50, 60);
select api.report_outbox_result(tests.id('n_bounce'), '{"status": "gone", "error_code": "hard_bounce"}');
select api.report_outbox_result(tests.id('n_complaint'), '{"status": "gone", "error_code": "complaint"}');
select results_eq($$ select org_id, value, reason from app.suppressions where reason <> 'stop' order by value $$,
  $$ values (tests.id('org_a'), 'grumpy@example.com', 'complaint'), (tests.id('org_b'), 'victim@example.com', 'bounce') $$,
  'a gone email writes a bounce or complaint suppression');
update app.notifications set status = 'queued', next_attempt_at = now(), locked_until = null, recipient_hash = null
where visit_id = tests.id('second');
delete from app.notifications where dedupe_key like 'cap%';
select is((select is_suppressed from api.claim_outbox(50, 60) where visit_id = tests.id('second')), true,
  'a bounce recorded by another org suppresses the address, and its variants, here too');

select results_eq($$ select private.canonical_email(v) from unnest(array[
    ' V.Ictim+news@GoogleMail.com ', 'victim@example.com.', 'do.dger+x@example.com', '+tag@example.com',
    '+14155550177']) v $$,
  $$ values ('victim@gmail.com'), ('victim@example.com'), ('do.dger@example.com'), ('+tag@example.com'),
            ('+14155550177') $$,
  'canonical_email folds case, +tags, trailing dots and gmail dots; other dots and phones stay');

select * from finish();
rollback;
