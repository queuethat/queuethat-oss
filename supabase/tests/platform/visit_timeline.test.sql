-- #1136: visit search and timeline for support, only under a live support grant. Denied without
-- a grant, after expiry or revoke, across tenants, to anon and without MFA; every call is audited;
-- no guest name or contact value is ever returned.
begin;
\ir ../helpers/_setup.psql
select plan(59);
select tests.create_world();

select tests.create_user('support');
insert into app.platform_roles (user_id, role) values (tests.id('support'), 'support');
select tests.create_user('support2');
insert into app.platform_roles (user_id, role) values (tests.id('support2'), 'support');
create function tests.as_support(p_aal text default 'aal2') returns void
language sql as $$ select tests.as_user(tests.id('support'), jsonb_build_object('aal', p_aal)) $$;
create function tests.as_support2() returns void
language sql as $$ select tests.as_user(tests.id('support2'), jsonb_build_object('aal', 'aal2')) $$;
create function tests.as_operator(p_aal text default 'aal2') returns void
language sql as $$ select tests.as_user(tests.id('platform'), jsonb_build_object('aal', p_aal)) $$;
grant execute on function tests.as_support(text), tests.as_support2(), tests.as_operator(text)
  to authenticated;

-- Fixtures: a distinctive guest in org A with a phone and a telegram contact, one visit of org B.
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'B queue', 'B');
select tests.new_visit('visit_b', 'queue_b', 'Bertha Otherorg');
select tests.new_visit('visit_z', 'queue_a', 'Zelda Secretname');
insert into app.guests (id, org_id, first_name) values (tests.new_id('guest_z'), tests.id('org_a'), 'Zelda');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_phone'), tests.id('org_a'), tests.id('guest_z'), 'phone', '+14155550188', 'online'),
       (tests.new_id('contact_email'), tests.id('org_a'), tests.id('guest_z'), 'email', 'zelda.secret@example.com', 'online'),
       (tests.new_id('contact_tg'), tests.id('org_a'), tests.id('guest_z'), 'telegram', 'tg:987654321', 'online');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version,
                               dedupe_key, status, error_code)
values (tests.new_id('n_sms'), tests.id('org_a'), tests.id('visit_z'), 'sms', tests.id('contact_phone'), 'joined', 1, 'tl-sms', 'sent', null),
       (tests.new_id('n_mail'), tests.id('org_a'), tests.id('visit_z'), 'email', tests.id('contact_email'), 'called', 1, 'tl-mail', 'failed', 'bounced'),
       (tests.new_id('n_tg'), tests.id('org_a'), tests.id('visit_z'), 'telegram', tests.id('contact_tg'), 'called', 1, 'tl-tg', 'sent', null),
       (tests.new_id('n_gone'), tests.id('org_a'), tests.id('visit_z'), 'sms', gen_random_uuid(), 'called', 1, 'tl-gone', 'dead', 'Invalid number +14155550188');

------------------------------------------------------------------------------------------------
-- No grant: nothing, for everyone
------------------------------------------------------------------------------------------------
select tests.as_support();
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_z')) $$,
  '42501', 'permission_denied', 'no grant: the timeline is denied to support');
select throws_ok($$ select * from api.platform_search_visits(tests.id('org_a')) $$,
  '42501', 'permission_denied', 'no grant: search is denied to support');
select tests.as_operator();
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_z')) $$,
  '42501', 'permission_denied', 'no grant: even an operator is denied');
select throws_ok($$ select api.platform_visit_timeline(gen_random_uuid(), gen_random_uuid()) $$,
  '42501', 'permission_denied', 'an unknown org answers like a tenant without a grant');
select tests.as_anon();
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_z')) $$,
  '42501', null, 'anon cannot call the timeline');
select throws_ok($$ select * from api.platform_search_visits(tests.id('org_a')) $$,
  '42501', null, 'anon cannot search');
select tests.act_as('owner');
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_z')) $$,
  '42501', 'permission_denied', 'the org owner is not platform support');
select tests.act_as('staff');
select throws_ok($$ select * from api.platform_search_visits(tests.id('org_a')) $$,
  '42501', 'permission_denied', 'org staff cannot use the support search');
select tests.act_as('other_owner');
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_z')) $$,
  '42501', 'permission_denied', 'another org''s owner is denied');
select tests.act_as('display');
select throws_ok($$ select * from api.platform_search_visits(tests.id('org_a')) $$,
  '42501', 'permission_denied', 'a paired screen is denied');
select tests.as_service();
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_z')) $$,
  '42501', null, 'the service role is not granted the function');

------------------------------------------------------------------------------------------------
-- Owner grants read access
------------------------------------------------------------------------------------------------
select tests.act_as('owner');
create temp table g1 as select * from api.grant_support_access(tests.id('org_a'), 'read', 24, 'Guest says never called');
grant select on g1 to authenticated;

select tests.as_support('aal1');
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_z')) $$,
  '42501', 'permission_denied', 'a grant needs an aal2 session (MFA)');
select throws_ok($$ select * from api.platform_search_visits(tests.id('org_a')) $$,
  '42501', 'permission_denied', 'search needs an aal2 session too');

select tests.as_support2();
select lives_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_z')) $$,
  'an owner grant is open to every support user');
select tests.as_support();

-- Content.
create temp table tl as select * from api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_z'));
grant select on tl to authenticated;
select is((select display_ticket from tl), (select display_ticket from app.visits where id = tests.id('visit_z')),
  'the timeline names the visit');
select is((select tz from tl), 'America/New_York', 'the timeline carries the location time zone');
select is((select support_grant ->> 'id' from tl), (select id::text from g1),
  'the timeline carries the grant it came through');
select is((select support_grant ->> 'reason' from tl), 'Guest says never called', 'and its reason');
select is((select support_grant ->> 'scope' from tl), 'read', 'and its scope');
select ok((select (support_grant ->> 'expires_at')::timestamptz > now() from tl), 'and its expiry');
select is((select jsonb_array_length(events) from tl), 1, 'a new visit has one event');
select is((select events -> 0 ->> 'type' from tl), 'joined', 'the event is the join');
select is((select events -> 0 ->> 'actor_kind' from tl), 'system', 'with its actor kind');
select is((select events -> 0 ->> 'via_support' from tl), 'false', 'not made by support');

-- Notifications: masked recipients only.
select is((select jsonb_array_length(notifications) from tl), 4, 'every notification for the visit is listed');
select is((select n ->> 'recipient' from tl, jsonb_array_elements(notifications) n where n ->> 'template_key' = 'joined'),
  '+•••••••0188', 'a phone is masked to its last four digits');
select is((select n ->> 'recipient' from tl, jsonb_array_elements(notifications) n where n ->> 'channel' = 'email'),
  'z•••@example.com', 'an email keeps its first letter and domain');
select is((select n ->> 'recipient' from tl, jsonb_array_elements(notifications) n where n ->> 'channel' = 'telegram'),
  'telegram', 'a telegram handle is not shown at all, only the channel');
select is((select n ->> 'recipient' from tl, jsonb_array_elements(notifications) n where n ->> 'status' = 'dead'),
  'sms', 'a notification whose contact is gone shows the channel');
select is((select n ->> 'error_code' from tl, jsonb_array_elements(notifications) n where n ->> 'channel' = 'email'),
  'bounced', 'a failure code is shown');

select is((select n ->> 'error_code' from tl, jsonb_array_elements(notifications) n where n ->> 'status' = 'dead'),
  null, 'an error that is prose rather than a code is not shown');

-- No PII anywhere in the response (I-13).
select ok((select tl::text from tl) !~* 'zelda|secretname|4155550188|secret@|987654321|bertha',
  'the response contains no guest name, number, address or handle');
select is((select array_agg(attname::text order by attnum) from pg_attribute
           where attrelid = (select typrelid from pg_type where oid = 'api.platform_visit_timeline'::regtype)
             and attnum > 0 and not attisdropped),
  array['visit_id', 'display_ticket', 'status', 'queue_name', 'location_name', 'tz', 'service_day',
        'source', 'party_size', 'call_count', 'joined_at', 'finished_at', 'support_grant', 'events',
        'notifications'],
  'the timeline''s column set is fixed: no guest name, contact or answers column');
select is((select array(select jsonb_object_keys(events -> 0) order by 1) from tl),
  array['actor_kind', 'from_status', 'id', 'occurred_at', 'to_status', 'type', 'undoes_type', 'undone', 'via_support'],
  'an event exposes exactly these keys: no actor id, reason or payload');
select is((select array(select jsonb_object_keys(notifications -> 0) order by 1) from tl),
  array['attempts', 'category', 'channel', 'created_at', 'error_code', 'event_id', 'id', 'recipient',
        'status', 'template_key', 'updated_at'],
  'a notification exposes exactly these keys: no vars, provider ids or raw recipient');
select is((select array_agg(attname::text order by attnum) from pg_attribute
           where attrelid = (select typrelid from pg_type where oid = 'api.platform_visit_hit'::regtype)
             and attnum > 0 and not attisdropped),
  array['visit_id', 'display_ticket', 'queue_id', 'queue_name', 'location_id', 'location_name',
        'service_day', 'status', 'joined_at', 'finished_at'],
  'a search hit has no guest name or contact column');

-- Audit: one row per call, naming the grant and the visit.
select tests.as_postgres();
select is((select count(*) from app.platform_audit where action = 'support.visit_timeline' and org_id = tests.id('org_a')),
  2::bigint, 'each timeline lookup is audited (support2 and support)');
select results_eq(
  $$ select actor_id, (target ->> 'support_grant_id')::uuid, (target ->> 'visit_id')::uuid, reason
     from app.platform_audit where action = 'support.visit_timeline' and actor_id = tests.id('support') $$,
  $$ values (tests.id('support'), (select id from g1), tests.id('visit_z'), 'Guest says never called') $$,
  'the audit row names who, which grant, which visit and why');
select is((select count(*) from app.platform_audit where action = 'support.visit_timeline' and actor_id is null),
  0::bigint, 'the denied calls above left no audit row');

-- Search.
select tests.new_visit('visit_y', 'queue_a', 'Yara Another');
select tests.as_support();
select is((select count(*) from api.platform_search_visits(tests.id('org_a'))), 3::bigint,
  'search lists org A visits only (not org B)');
select is((select count(*) from api.platform_search_visits(tests.id('org_a'),
  (select display_ticket from app.visits where id = tests.id('visit_z')))), 1::bigint,
  'search by full ticket');
select is((select count(*) from api.platform_search_visits(tests.id('org_a'),
  lower((select display_ticket from app.visits where id = tests.id('visit_z'))))), 1::bigint,
  'ticket search ignores case');
select is((select visit_id from api.platform_search_visits(tests.id('org_a'),
  (select ticket_number::text from app.visits where id = tests.id('visit_z')))), tests.id('visit_z'),
  'a bare number finds the ticket');
select is((select count(*) from api.platform_search_visits(tests.id('org_a'), '99999999999')), 0::bigint,
  'a number too big for a ticket matches nothing and is not an error');
select is((select count(*) from api.platform_search_visits(tests.id('org_a'), p_status => 'served')), 0::bigint,
  'search by status');
select is((select count(*) from api.platform_search_visits(tests.id('org_a'), p_status => 'waiting')), 3::bigint,
  'search by status finds waiting visits');
select is((select count(*) from api.platform_search_visits(tests.id('org_a'), p_queue_id => tests.id('queue_a'))), 3::bigint,
  'search by queue');
select is((select count(*) from api.platform_search_visits(tests.id('org_a'), p_queue_id => tests.id('queue_b'))), 0::bigint,
  'a queue of another org matches nothing');
select is((select count(*) from api.platform_search_visits(tests.id('org_a'), p_limit => 1)), 1::bigint,
  'search honours the limit');
select throws_ok($$ select * from api.platform_search_visits(tests.id('org_a'), p_limit => 0) $$,
  'P0001', 'invalid_input', 'a zero limit is refused');
select throws_ok($$ select * from api.platform_search_visits(tests.id('org_a'), p_limit => 51) $$,
  'P0001', 'invalid_input', 'a limit over 50 is refused');
select throws_ok($$ select * from api.platform_search_visits(tests.id('org_a'), p_limit => null) $$,
  'P0001', 'invalid_input', 'a null limit is refused');
select throws_ok($$ select * from api.platform_search_visits(tests.id('org_a'), repeat('9', 21)) $$,
  'P0001', 'invalid_input', 'an over-long ticket is refused');
select tests.as_postgres();
select ok((select count(*) from app.platform_audit where action = 'support.visit_search'
           and org_id = tests.id('org_a') and (target ->> 'support_grant_id')::uuid = (select id from g1)) >= 10,
  'every search is audited with the grant');

-- Cross-tenant.
select tests.as_support();
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), tests.id('visit_b')) $$,
  'P0001', 'not_found', 'a visit of another org is not_found under org A''s grant');
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_b'), tests.id('visit_b')) $$,
  '42501', 'permission_denied', 'org A''s grant opens nothing in org B');
select throws_ok($$ select * from api.platform_search_visits(tests.id('org_b')) $$,
  '42501', 'permission_denied', 'org A''s grant cannot search org B');
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), gen_random_uuid()) $$,
  'P0001', 'not_found', 'an unknown visit is not_found');
select throws_ok($$ select api.platform_visit_timeline(tests.id('org_a'), null) $$,
  'P0001', 'not_found', 'a null visit is not_found');

select * from finish();
rollback;
