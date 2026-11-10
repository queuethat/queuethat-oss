-- N5 (#255): channel fallback chain.
begin;
\ir ../helpers/_setup.psql
select plan(10);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_f'), tests.id('org_a'), tests.id('loc_a'), 'Chain', 'F');
-- The guest typed an email (transactional mail consent) and has a push subscription.
select tests.new_visit('fv', 'queue_f');
update app.visits set guest_email = 'chain@example.com' where id = tests.id('fv');
insert into app.push_subscriptions (id, org_id, visit_id, endpoint, p256dh, auth)
values (tests.new_id('sub_f'), tests.id('org_a'), tests.id('fv'), 'https://fcm.googleapis.com/fcm/send/f', 'k', 'a');
alter table app.visit_events disable trigger enqueue_notifications;

-- Without a fallback deadline nothing changes: every channel at once.
select private.enqueue_notification((select v from app.visits v where v.id = tests.id('fv')), null, 'almost_up', 'plain');
select is((select count(*)::int from app.notifications where dedupe_key like 'plain:%'), 2, 'an unchained template still queues every channel');

-- With one, only the first consented channel (push) is queued, as step 1.
update app.notification_templates set fallback_after_seconds = 60 where trigger = 'almost_up' and org_id is null;
select private.enqueue_notification((select v from app.visits v where v.id = tests.id('fv')), null, 'almost_up', 'chain');
select results_eq($$ select channel::text, chain_step from app.notifications where dedupe_key like 'chain:%:%' and chain_id is not null and dedupe_key not like 'chain:%:%:%' $$,
  $$ values ('push', 1) $$, 'a chained template queues only the first channel');
select ok((select fallback_at > now() + interval '50 seconds' from app.notifications where dedupe_key like 'chain:push:%'), 'the deadline is recorded');

-- Push dies: email step 2 appears with the same chain.
select tests.as_postgres();
create temp table first as select * from app.notifications where dedupe_key like 'chain:push:%';
update app.notifications set status = 'dead' where id = (select id from first);
select is((select count(*)::int from app.notifications n, first f where n.chain_id = f.chain_id and n.chain_step = 2 and n.channel = 'email'), 1,
  'a dead push hands over to email as step 2');
select is((select count(*)::int from app.notifications n, first f where n.chain_id = f.chain_id), 2, 'and sms and telegram are skipped (no template or consent)');

-- A second dead step has nowhere left to go.
update app.notifications set status = 'dead' where chain_id = (select chain_id from first) and chain_step = 2;
select is((select count(*)::int from app.notifications n, first f where n.chain_id = f.chain_id), 2, 'the end of the chain adds nothing');

-- A missed deadline hands over too, but not once the guest is no longer waiting.
select private.enqueue_notification((select v from app.visits v where v.id = tests.id('fv')), null, 'almost_up', 'late');
update app.notifications set fallback_at = now() - interval '1 second' where dedupe_key like 'late:push:%';
select is(ops.advance_notification_chains(), 1, 'the sweep picks up the overdue step');
select is((select count(*)::int from app.notifications where dedupe_key like 'chain:%' and chain_step = 2 and dedupe_key <> (select 'chain:' || chain_id || ':2' from first)), 1,
  'and queues its email fallback');

select tests.act_as('other_owner');
select is((select count(*)::int from app.notifications where chain_id is not null), 0, 'org B sees no org A chains');

select tests.as_postgres();
select private.set_actor('staff', tests.id('staff'), 'call');
update app.visits set status = 'called' where id = tests.id('fv');
select private.set_actor('staff', tests.id('staff'), 'no_show');
update app.visits set status = 'no_show' where id = tests.id('fv');
select private.enqueue_notification((select v from app.visits v where v.id = tests.id('fv')), null, 'almost_up', 'gone');
update app.notifications set fallback_at = now() - interval '1 second' where dedupe_key like 'gone:push:%';
select ops.advance_notification_chains();
select is((select count(*)::int from app.notifications n where n.chain_id = (select chain_id from app.notifications where dedupe_key like 'gone:push:%')), 1,
  'a guest who is no longer waiting gets no fallback');

select * from finish();
rollback;
