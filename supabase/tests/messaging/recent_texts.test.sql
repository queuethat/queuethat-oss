-- T4 (#1239): api.list_recent_texts, the shop's "did my customer get it?" list. Outcomes are decided in the
-- database, numbers are masked, bodies never appear, and other tenants and staff below manager get nothing.
begin;
\ir ../helpers/_setup.psql
select plan(12);
select tests.create_world();

-- org A's visit_a has phone contact_a (+14155550123). One text per outcome.
create function tests.text(p_key text, p_status app.notification_status, p_delivery text, p_error text,
                           p_deferred boolean default false, p_next timestamptz default now(),
                           p_at timestamptz default now()) returns void
language sql as $$
  insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key,
                                 status, delivery_status, error_code, quiet_hours_deferred, next_attempt_at, created_at,
                                 vars)
  values (tests.new_id(p_key), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('contact_a'), 'called', 1, p_key,
          p_status, p_delivery, p_error, p_deferred, p_next, p_at, '{"guest_first_name":"Gina"}')
$$;
select tests.text('t_delivered', 'sent', 'delivered', null, p_at => now() - interval '1 minute');
select tests.text('t_sent', 'sent', 'sent', null, p_at => now() - interval '2 minutes');
select tests.text('t_undelivered', 'sent', 'undelivered', 'twilio_30003', p_at => now() - interval '3 minutes');
select tests.text('t_dead', 'dead', null, 'http_500', p_at => now() - interval '4 minutes');
select tests.text('t_stop', 'suppressed', null, 'suppressed', p_at => now() - interval '5 minutes');
select tests.text('t_consent', 'suppressed', null, 'no_consent', p_at => now() - interval '6 minutes');
select tests.text('t_quiet', 'queued', null, null, true, now() + interval '8 hours', now() - interval '7 minutes');
select tests.text('t_queued', 'queued', null, null, p_at => now() - interval '8 minutes');
select tests.text('t_old', 'sent', 'delivered', null, p_at => now() - interval '8 days');
-- An email of the same visit is not a text.
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
values (tests.id('org_a'), tests.id('visit_a'), 'email', tests.id('visit_a'), 'called', 1, 't_email');

select tests.act_as('manager');
select results_eq(
  format('select id, outcome, reason from api.list_recent_texts(%L)', tests.id('loc_a')),
  $$ values (tests.id('t_delivered'), 'delivered', null::text), (tests.id('t_sent'), 'sent', null),
            (tests.id('t_undelivered'), 'failed', 'twilio_30003'), (tests.id('t_dead'), 'failed', 'http_500'),
            (tests.id('t_stop'), 'blocked_stop', 'suppressed'), (tests.id('t_consent'), 'not_sent', 'no_consent'),
            (tests.id('t_quiet'), 'quiet_hours', null), (tests.id('t_queued'), 'sending', null) $$,
  'each text of the last 7 days, newest first, with the outcome the database decides; email and older texts left out');
select is((select number_hint from api.list_recent_texts(tests.id('loc_a')) limit 1), '23', 'the number shows its last two digits only');
select is((select ticket from api.list_recent_texts(tests.id('loc_a')) limit 1),
  (select display_ticket from app.visits where id = tests.id('visit_a')), 'and the visit''s ticket');
select is((select count(*)::int from api.list_recent_texts(tests.id('loc_a')) r
           where row_to_json(r)::text like '%4155550123%' or row_to_json(r)::text like '%Gina%'), 0,
  'never the full number or message content');
select is((select count(*)::int from api.list_recent_texts(tests.id('loc_a'), now() - interval '4 minutes 30 seconds')), 4,
  'p_before pages to older texts');

-- A text held for quiet hours whose window has opened is just waiting to go.
select tests.as_postgres();
update app.notifications set next_attempt_at = now() - interval '1 minute' where id = tests.id('t_quiet');
select tests.act_as('admin');
select is((select outcome from api.list_recent_texts(tests.id('loc_a')) where id = tests.id('t_quiet')), 'sending',
  'once the window opens a held text shows as sending');
select tests.act_as('owner');
select is((select count(*)::int from api.list_recent_texts(tests.id('loc_a'))), 8, 'owners see the list');

-- Access.
select tests.act_as('staff');
select throws_ok(format('select * from api.list_recent_texts(%L)', tests.id('loc_a')), 'P0001', 'not_found',
  'staff below manager are refused');
select tests.act_as('other_owner');
select throws_ok(format('select * from api.list_recent_texts(%L)', tests.id('loc_a')), 'P0001', 'not_found',
  'another tenant''s owner gets not_found (cross-tenant)');
select is((select count(*)::int from api.list_recent_texts(tests.id('loc_b'))), 0, 'and their own location has none of org A''s texts');
select tests.act_as('anon');
select throws_ok(format('select * from api.list_recent_texts(%L)', tests.id('loc_a')), '42501', null, 'anon is refused');
select throws_ok($$ select * from api.list_recent_texts(gen_random_uuid()) $$, '42501', null, 'an unknown location too');

select * from finish();
rollback;
