-- #1138: in-app contact support. Members file requests with sanitised context; the support inbox and the
-- requester get one outbox email each; org A can never reach org B's requests; anon cannot call it;
-- platform staff list and close requests behind aal2.
begin;
\ir ../helpers/_setup.psql
select plan(90);
select tests.create_world();

grant select on all tables in schema tests to anon, authenticated;
-- the fixture row from create_world is not part of these counts
delete from app.support_requests;

/** Files a request as p_actor; returns the reference, or the error text. */
create function tests.try_support(p_actor text, p_org text, p_subject text, p_message text, p_context jsonb default null)
returns text language plpgsql as $$
declare
  v text;
begin
  perform tests.act_as(p_actor);
  v := api.contact_support(tests.id(p_org), p_subject, p_message, p_context);
  perform tests.as_postgres();
  return v;
exception when others then
  perform tests.as_postgres();
  return sqlerrm;
end $$;

-- ---------------------------------------------------------------- who may call it
select tests.as_anon();
select throws_ok($$ select api.contact_support(tests.id('org_a'), 's', 'm') $$, '42501', null,
  'anon cannot execute contact_support');
select tests.as_postgres();

select tests.set_claims('authenticated', '{"role":"authenticated"}');
select throws_ok($$ select api.contact_support(tests.id('org_a'), 's', 'm') $$, '42501', 'not_authenticated',
  'a session without a user is not authenticated');
select tests.as_postgres();

select matches(tests.try_support('staff', 'org_a', 'Blank screen', 'The queue page is blank.'), '^SR-\d{6}$',
  'a staff member files a request and gets an SR-number');
select is((select count(*)::int from app.support_requests), 1, 'one request stored');
select is((select user_id from app.support_requests), tests.id('staff'), 'the user comes from the session');
select is((select org_id from app.support_requests), tests.id('org_a'), 'the org is the one the caller belongs to');
select is((select context ->> 'role' from app.support_requests), 'staff', 'the role comes from the membership');
select is((select context ->> 'org_name' from app.support_requests), 'Org A', 'the org name comes from the database');
select is((select context ->> 'plan' from app.support_requests), private.org_plan(tests.id('org_a')),
  'the plan comes from the database');
select is((select status from app.support_requests), 'open', 'a new request is open');

-- ---------------------------------------------------------------- tenancy
select is(tests.try_support('other_owner', 'org_a', 'Peek', 'I am in another org'), 'not_found',
  'cross-tenant: a member of org B cannot file against org A');
select is(tests.try_support('staff', 'org_b', 'Peek', 'I am in another org'), 'not_found',
  'cross-tenant: a member of org A cannot file against org B');
select is(tests.try_support('staff', 'org_a', 'Peek', 'x') ~ '^SR-', true, 'control: staff still files in own org');
select is((select count(*)::int from app.support_requests where org_id = tests.id('org_b')), 0,
  'nothing was written for org B');
select is(tests.try_support('display', 'org_a', 'Screen', 'A paired TV has no membership'), 'not_found',
  'a paired device (no membership) is refused');

-- reads: owners/admins see the whole org, others only their own, other orgs nothing
select tests.try_support('admin', 'org_a', 'Admin question', 'From the admin');
select tests.act_as('staff');
select is((select count(*)::int from app.support_requests), 2, 'staff read only their own requests');
select tests.act_as('admin');
select is((select count(*)::int from app.support_requests), 3, 'an admin reads every request of the org');
select tests.act_as('manager');
select is((select count(*)::int from app.support_requests), 0, 'a manager who filed none reads none');
select tests.act_as('other_owner');
select is((select count(*)::int from app.support_requests), 0, 'cross-tenant: org B reads no org A request');
select tests.as_anon();
select throws_ok($$ select count(*) from app.support_requests $$, '42501', null, 'anon has no table access');
select tests.act_as('staff');
select throws_ok($$ insert into app.support_requests (org_id, user_id, subject, message)
                    values (tests.id('org_a'), tests.id('staff'), 'x', 'x') $$, '42501', null,
  'no client inserts a row directly (everything goes through the RPC)');
select tests.as_postgres();

-- ---------------------------------------------------------------- suspended org and revoked membership
update app.organizations set status = 'suspended' where id = tests.id('org_a');
select matches(tests.try_support('staff', 'org_a', 'Suspended', 'Why are we suspended?'), '^SR-',
  'a suspended org can still contact support');
update app.organizations set status = 'active' where id = tests.id('org_a');

delete from app.memberships where org_id = tests.id('org_a') and user_id = tests.id('manager');
select is(tests.try_support('manager', 'org_a', 'Gone', 'My membership was revoked'), 'not_found',
  'a revoked membership is refused');

-- ---------------------------------------------------------------- double submit and rate limit
delete from app.support_requests;
delete from app.notifications;

create temp table refs (k text primary key, ref text);
grant all on refs to authenticated;
insert into refs select 'first', tests.try_support('staff', 'org_a', 'Same words', 'Same message');
insert into refs select 'again', tests.try_support('staff', 'org_a', 'Same words', 'Same message');
select is((select ref from refs where k = 'again'), (select ref from refs where k = 'first'),
  'the same words within 60 s return the same reference');
select is((select count(*)::int from app.support_requests), 1, 'a double submit stores one request');
select is((select count(*)::int from app.notifications), 2, 'and queues one support email and one confirmation');

update app.support_requests set created_at = now() - interval '61 seconds';
insert into refs select 'later', tests.try_support('staff', 'org_a', 'Same words', 'Same message');
select isnt((select ref from refs where k = 'later'), (select ref from refs where k = 'first'),
  'the same words after 60 s are a new request');

select isnt(tests.try_support('staff', 'org_a', 'Same words', 'Different message'), (select ref from refs where k = 'first'),
  'different words are a new request');
select matches(tests.try_support('staff', 'org_a', 'Third', 'Third message'), '^SR-', 'the fourth request of the hour passes');
select matches(tests.try_support('staff', 'org_a', 'Fourth', 'Fourth message'), '^SR-', 'the fifth request of the hour passes');
select is(tests.try_support('staff', 'org_a', 'Sixth', 'Sixth message'), 'rate_limited',
  'the sixth request in an hour is rate limited');
select is(tests.try_support('staff', 'org_a', 'Fourth', 'Fourth message') ~ '^SR-', true,
  'repeating the last request at the limit still returns its reference');
select matches(tests.try_support('admin', 'org_a', 'Admin', 'The limit is per person'), '^SR-',
  'one person at the limit does not block another');
update app.support_requests set created_at = now() - interval '2 hours' where user_id = tests.id('staff');
select matches(tests.try_support('staff', 'org_a', 'Sixth', 'Sixth message'), '^SR-', 'the limit lifts after an hour');

-- ---------------------------------------------------------------- input bounds
delete from app.support_requests;
select is(tests.try_support('staff', 'org_a', '', 'm'), 'invalid_input', 'an empty subject is refused');
select is(tests.try_support('staff', 'org_a', '   ', 'm'), 'invalid_input', 'a blank subject is refused');
select is(tests.try_support('staff', 'org_a', null, 'm'), 'invalid_input', 'a null subject is refused');
select is(tests.try_support('staff', 'org_a', repeat('s', 121), 'm'), 'invalid_input', 'a 121 character subject is refused');
select matches(tests.try_support('staff', 'org_a', repeat('s', 120), 'm'), '^SR-', 'a 120 character subject is accepted');
select is(tests.try_support('staff', 'org_a', E'two\nlines', 'm'), 'invalid_input', 'a subject with a line break is refused (mail header safety)');
select is(tests.try_support('staff', 'org_a', 's', ''), 'invalid_input', 'an empty message is refused');
select is(tests.try_support('staff', 'org_a', 's', E' \n '), 'invalid_input', 'a blank message is refused');
select is(tests.try_support('staff', 'org_a', 's', null), 'invalid_input', 'a null message is refused');
select is(tests.try_support('staff', 'org_a', 's', repeat('m', 4001)), 'invalid_input', 'a 4001 character message is refused');
select matches(tests.try_support('staff', 'org_a', 's2', repeat('m', 4000)), '^SR-', 'a 4000 character message is accepted');
select matches(tests.try_support('staff', 'org_a', 's3', E'line one\r\nline two\tindented'), '^SR-',
  'line breaks and tabs are fine in a message');
select is(tests.try_support('staff', 'org_a', 's4', 'bell' || chr(7)), 'invalid_input', 'other control characters are refused');
select is(tests.try_support('staff', 'org_a', 's5', 'm', '[1,2]'::jsonb), 'invalid_input', 'a context that is not an object is refused');
select is(tests.try_support('staff', 'org_a', 's6', 'm', jsonb_build_object('browser', repeat('b', 5000))), 'invalid_input',
  'an oversized context is refused');

-- ---------------------------------------------------------------- context sanitising
delete from app.support_requests;
delete from app.notifications;
select tests.try_support('staff', 'org_a', 'Context', 'Look at my page', jsonb_build_object(
  'route', '/admin/queues?token=SECRET&x=1#frag',
  'app_version', '20261102010101', 'browser', 'Mozilla/5.0 Test', 'viewport', jsonb_build_object('w', 1024, 'h', 768),
  'online', false, 'last_error_id', 'err_123',
  'localStorage', jsonb_build_object('sb-token', 'SECRET'), 'token', 'SECRET', 'org_name', 'Forged', 'role', 'owner',
  'user_id', tests.id('owner')));
select is((select context ->> 'route' from app.support_requests), '/admin/queues', 'the query string and fragment are stripped');
select is((select context ->> 'app_version' from app.support_requests), '20261102010101', 'the app version is kept');
select is((select context ->> 'browser' from app.support_requests), 'Mozilla/5.0 Test', 'the browser is kept');
select is((select context -> 'viewport' from app.support_requests), '{"w": 1024, "h": 768}'::jsonb, 'the viewport is kept');
select is((select context -> 'online' from app.support_requests), 'false'::jsonb, 'the online state is kept');
select is((select context ->> 'last_error_id' from app.support_requests), 'err_123', 'the last error id is kept');
select is((select context ->> 'org_name' from app.support_requests), 'Org A', 'a forged org name is ignored');
select is((select context ->> 'role' from app.support_requests), 'staff', 'a forged role is ignored');
select is((select (context - 'route' - 'app_version' - 'browser' - 'viewport' - 'online' - 'last_error_id'
                   - 'org_name' - 'role' - 'plan')::text from app.support_requests), '{}',
  'nothing outside the whitelist is stored (no storage, tokens or ids)');
select is(private.support_route('/v/abcdef'), null::text, 'a guest status path is refused');
select is(private.support_route('/q/demo-barber?x=1'), null::text, 'a guest join path is refused');
select is(private.support_route('https://evil.test/x'), null::text, 'an absolute URL is refused');
select is(private.support_route('/admin/' || repeat('a', 43)), '/admin/:redacted', 'a long opaque segment is redacted');
select is(private.support_route('/admin/locations/11111111-1111-1111-1111-111111111111'),
  '/admin/locations/11111111-1111-1111-1111-111111111111', 'an ordinary id in the path is kept');

-- ---------------------------------------------------------------- the two emails
select is((select count(*)::int from app.notifications where template_key = 'support_request'), 1,
  'one email to the support inbox');
select is((select count(*)::int from app.notifications where template_key = 'support_confirmation'), 1,
  'one confirmation to the requester');
select is((select private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)
           from app.notifications n where n.template_key = 'support_request'),
  'support@queuethat.com', 'the support email goes to the support inbox');
select is((select private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)
           from app.notifications n where n.template_key = 'support_confirmation'),
  (select email::text from auth.users where id = tests.id('staff')), 'the confirmation goes to the requester''s own address');
select is((select private.notification_address(n.channel, n.visit_id, n.recipient_ref, tests.id('org_b'))
           from app.notifications n where n.template_key = 'support_request'), null::text,
  'the inbox is not resolved for another org''s id');
select ok((select vars ? 'message' and vars ->> 'subject' = 'Context' and vars ->> 'user_email' is not null
                  and vars ->> 'route' = '/admin/queues' and vars ->> 'org' = 'Org A'
           from app.notifications where template_key = 'support_request'),
  'the support email carries the message, requester, org and page');
select ok((select not (vars ? 'message') and vars ->> 'reference' ~ '^SR-' from app.notifications
           where template_key = 'support_confirmation'), 'the confirmation has the reference and no copy of the message');
select ok((select visit_id is null and category = 'transactional' and channel = 'email' and status = 'queued'
           from app.notifications where template_key = 'support_request'), 'both go through the outbox as account mail');
update app.platform_flags set support_inbox = 'help@selfhost.test';
select is((select private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)
           from app.notifications n where n.template_key = 'support_request'),
  'help@selfhost.test', 'a self-hoster''s own inbox is used');
select throws_ok($$ update app.platform_flags set support_inbox = 'not an address' $$, '23514', null,
  'the inbox must look like an address');

-- ---------------------------------------------------------------- platform console
create temp table req as select id, 'SR-' || lpad(number::text, 6, '0') as ref from app.support_requests;
grant select on req to authenticated;

select tests.act_as('platform');
select is((select count(*)::int from api.platform_list_support_requests(tests.id('org_a'))), 1,
  'an operator lists the org''s requests');
select is((select reference || '|' || subject || '|' || status from api.platform_list_support_requests(tests.id('org_a'), 'open')),
  (select ref from req) || '|Context|open', 'with reference, subject and status');
select is((select count(*)::int from api.platform_list_support_requests(tests.id('org_b'))), 0, 'another org lists nothing');
select throws_ok($$ select * from api.platform_list_support_requests(tests.id('org_a'), 'bogus') $$, 'P0001', 'invalid_input',
  'an unknown status filter is refused');
select lives_ok($$ select api.platform_set_support_request_status((select id from req), 'closed') $$,
  'an operator closes a request');
select api.platform_set_support_request_status((select id from req), 'closed');
select is((select count(*)::int from api.platform_list_support_requests(tests.id('org_a'), 'open')), 0, 'it is gone from the open list');
select is((select count(*)::int from api.platform_list_support_requests(tests.id('org_a'), 'closed')), 1, 'and is on the closed list');
select tests.as_postgres();
select is((select status from app.support_requests), 'closed', 'the request is closed');
select ok((select closed_at is not null and closed_by = tests.id('platform') from app.support_requests), 'with who and when');
select is((select count(*)::int from app.platform_audit where action = 'support_request.close'), 1,
  'closing twice is a no-op and is audited once');
select tests.act_as('platform');
select api.platform_set_support_request_status((select id from req), 'open');
select tests.as_postgres();
select ok((select status = 'open' and closed_at is null from app.support_requests), 'a request can be reopened');
select tests.act_as('platform');
select throws_ok($$ select api.platform_set_support_request_status(gen_random_uuid(), 'closed') $$, 'P0001', 'not_found',
  'an unknown request is not_found');
select throws_ok($$ select api.platform_set_support_request_status((select id from req), 'x') $$, 'P0001',
  'invalid_input', 'an unknown status is refused');

select tests.act_as('staff');
select throws_ok($$ select * from api.platform_list_support_requests(tests.id('org_a')) $$, '42501', 'permission_denied',
  'an org member without a platform role cannot list');
select throws_ok($$ select api.platform_set_support_request_status((select id from req), 'closed') $$, '42501',
  'permission_denied', 'nor close');
select tests.set_claims('authenticated', (select a.claims || '{"aal":"aal1"}' from tests.actors a where a.name = 'platform'));
select throws_ok($$ select * from api.platform_list_support_requests(tests.id('org_a')) $$, '42501', 'permission_denied',
  'a platform user without an MFA session cannot list');
select tests.as_anon();
select throws_ok($$ select * from api.platform_list_support_requests(tests.id('org_a')) $$, '42501', null, 'anon cannot list');
select tests.as_postgres();

select * from finish();
rollback;
