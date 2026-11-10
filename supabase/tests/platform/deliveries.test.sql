-- #1130: platform support's delivery log. Metadata and masked recipients only; roles, MFA,
-- tenant scoping, paging boundaries, time zones, suspended and empty tenants, audit.
begin;
\ir ../helpers/_setup.psql
select plan(68);

select tests.create_world();
select tests.create_user('support');
insert into app.platform_roles (user_id, role) values (tests.id('support'), 'support');
create function tests.as_operator() returns void
language sql as $$ select tests.as_user(tests.id('platform'), '{"aal":"aal2"}') $$;
create function tests.as_support() returns void
language sql as $$ select tests.as_user(tests.id('support'), '{"aal":"aal2"}') $$;
grant execute on function tests.as_operator(), tests.as_support() to authenticated;

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Queue B', 'B');
select tests.new_visit('visit_b', 'queue_b');
update app.visits set guest_email = 'zelda.guest@example.com' where id = tests.id('visit_a');
update app.visits set guest_email = 'bee@orgb-secret.test' where id = tests.id('visit_b');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_s'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550999', 'online');

/** Inserts one notification for org A (or B) with explicit time, status and recipient. */
create function tests.msg(p_key text, p_org text, p_visit text, p_channel app.notification_channel, p_ref uuid,
                          p_status app.notification_status, p_at timestamptz, p_provider text, p_error text,
                          p_attempts int default 1) returns void
language sql as $$
  insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version,
                                 dedupe_key, status, created_at, updated_at, provider, error_code, attempts, vars)
  values (tests.new_id(p_key), tests.id(p_org), tests.id(p_visit), p_channel, p_ref, 'called', 1, p_key,
          p_status, p_at, p_at, p_provider, p_error, p_attempts, '{"secret_var": "SENTINEL_VARS"}')
$$;
select tests.msg('n1', 'org_a', 'visit_a', 'sms', tests.id('contact_a'), 'sent', '2026-03-10 09:00Z', 'twilio', null);
select tests.msg('n2', 'org_a', 'visit_a', 'email', tests.id('visit_a'), 'failed', '2026-03-10 09:30Z', 'resend', 'http_503', 3);
select tests.msg('n3', 'org_a', 'visit_a', 'sms', tests.id('contact_s'), 'suppressed', '2026-03-10 10:00Z', null, 'suppressed');
select tests.msg('n4', 'org_a', 'visit_a', 'push', tests.id('push_a'), 'sent', '2026-03-10 11:00Z', 'webpush', null);
select tests.msg('n5', 'org_a', 'visit_a', 'email', tests.id('visit_a'), 'dead', '2026-03-10 12:00Z', 'resend', 'invalid_recipient', 6);
-- Three rows in the same instant: paging must not skip or repeat any of them.
select tests.msg('n6', 'org_a', 'visit_a', 'sms', tests.id('contact_a'), 'queued', '2026-03-10 13:00Z', null, null, 0);
select tests.msg('n7', 'org_a', 'visit_a', 'sms', tests.id('contact_a'), 'queued', '2026-03-10 13:00Z', null, null, 0);
select tests.msg('n8', 'org_a', 'visit_a', 'sms', tests.id('contact_a'), 'queued', '2026-03-10 13:00Z', null, null, 0);
select tests.msg('nb', 'org_b', 'visit_b', 'email', tests.id('visit_b'), 'failed', '2026-03-10 09:45Z', 'resend', 'http_500', 2);
update app.notifications set delivery_status = 'delivered' where id = tests.id('n1');
-- Providers pick error codes: free text that could carry an address must never come through.
select tests.msg('n9', 'org_a', 'visit_a', 'sms', tests.id('contact_a'), 'failed', '2026-03-10 14:00Z', 'twilio', 'bad +14155550123 or z@example.com');
select tests.msg('n10', 'org_a', 'visit_a', 'sms', tests.id('contact_a'), 'failed', '2026-03-10 14:10Z', 'twilio', '14155550123');
select tests.msg('n11', 'org_a', 'visit_a', 'sms', tests.id('contact_a'), 'failed', '2026-03-10 14:20Z', 'twilio', 'twilio_30003');
insert into app.webhook_deliveries (id, org_id, endpoint_id, event_id, event_type, payload, status, attempts,
                                    response_status, error, created_at)
values (tests.new_id('w1'), tests.id('org_a'), tests.id('webhook_a'), 'e1', 'visit.called', '{"name": "SENTINEL_PAYLOAD"}',
        'failed', 2, 503, 'secret-body-xyz', '2026-03-10 10:30Z');

-- Row ids in order, for the paging checks, read as the caller.
create function tests.all_pages(p_org uuid, p_size int, p_status text default null) returns setof uuid
language plpgsql as $$
declare
  r record;
  v_at timestamptz;
  v_id uuid;
  v_n int;
begin
  loop
    v_n := 0;
    for r in select * from api.platform_org_deliveries(p_org, '2026-03-10 00:00Z', '2026-03-11 00:00Z', p_status,
                                                       null, p_size, v_at, v_id) loop
      return next r.id;
      v_at := r.created_at; v_id := r.id; v_n := v_n + 1;
    end loop;
    exit when v_n < p_size;
  end loop;
end $$;
grant execute on function tests.all_pages(uuid, int, text) to authenticated;

-- Roles ----------------------------------------------------------------------------------------
select tests.as_support();
select is((select count(*) from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 00:00Z', '2026-03-11 00:00Z')),
  12::bigint, 'support reads org A: 11 messages and 1 webhook delivery');
select tests.as_operator();
select is((select count(*) from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 00:00Z', '2026-03-11 00:00Z')),
  12::bigint, 'operator reads the same');
select tests.act_as('owner');
select throws_ok($$ select * from api.platform_org_deliveries(tests.id('org_a')) $$, '42501', 'permission_denied',
  'the tenant''s own owner is not platform support');
select tests.act_as('staff');
select throws_ok($$ select * from api.platform_delivery_summary(now() - interval '1 day', now()) $$, '42501', 'permission_denied',
  'tenant staff cannot read the summary');
select tests.as_anon();
select throws_ok($$ select * from api.platform_org_deliveries(null::uuid) $$, '42501', null, 'anon cannot call the log');
select throws_ok($$ select * from api.platform_delivery_summary(now() - interval '1 day', now()) $$, '42501', null,
  'anon cannot call the summary');
select tests.as_user(tests.id('support'), '{"aal":"aal1"}');
select throws_ok($$ select * from api.platform_org_deliveries(tests.id('org_a')) $$, '42501', 'permission_denied',
  'MFA: a platform role at aal1 is refused');
select throws_ok($$ select * from api.platform_delivery_summary(now() - interval '1 day', now()) $$, '42501', 'permission_denied',
  'MFA: the summary also needs aal2');
select tests.as_user(tests.id('other_owner'), '{"aal":"aal2"}');
select throws_ok($$ select * from api.platform_org_deliveries(tests.id('org_a')) $$, '42501', 'permission_denied',
  'another tenant''s owner, even at aal2, is refused');

-- Tenant scoping --------------------------------------------------------------------------------
select tests.as_support();
select is((select count(*) from api.platform_org_deliveries(tests.id('org_b'), '2026-03-10 00:00Z', '2026-03-11 00:00Z')),
  1::bigint, 'cross-tenant: org B shows only its own row');
select ok(not exists (select 1 from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 00:00Z', '2026-03-11 00:00Z')
                      where org_id <> tests.id('org_a')), 'cross-tenant: org A never includes org B rows');
select is((select count(*) from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 00:00Z', '2026-03-11 00:00Z') where org_name = 'Org A'),
  12::bigint, 'rows name their org');

-- Content: masks, no bodies or contact data ------------------------------------------------------
create temp table log_a as
  select * from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 00:00Z', '2026-03-11 00:00Z');
select tests.as_postgres();
select is((select recipient_masked from log_a where id = tests.id('n1')), '******23', 'a phone keeps its last two digits');
select is((select recipient_masked from log_a where id = tests.id('n2')), 'z***@example.com', 'an email keeps its first letter and domain');
select is((select recipient_masked from log_a where id = tests.id('n4')), null, 'push has no recipient');
select is((select recipient_masked from log_a where id = tests.id('w1')), 'example.com', 'a webhook shows only its host');
select is((select error_code from log_a where id = tests.id('w1')), 'http_503', 'a webhook failure shows its status, not the receiver''s error text');
select is((select suppression_reason from log_a where id = tests.id('n3')), 'stop', 'a suppressed text names the suppression-list reason');
select is((select suppression_reason from log_a where id = tests.id('n1')), null, 'a sent text has no suppression reason');
select is((select delivery_status from log_a where id = tests.id('n1')), 'delivered', 'the provider''s delivery report comes through');
select is((select provider from log_a where id = tests.id('n1')), 'twilio', 'provider comes through');
select is((select error_code from log_a where id = tests.id('n9')), 'other', 'an error code carrying an address or number is replaced');
select is((select error_code from log_a where id = tests.id('n10')), 'other', 'an error code that is a long digit run is replaced');
select is((select error_code from log_a where id = tests.id('n11')), 'twilio_30003', 'a plain provider code comes through');
select is((select attempts from log_a where id = tests.id('n5')), 6, 'attempts come through');
select ok((select to_jsonb(l)::text from (select jsonb_agg(to_jsonb(x)) from log_a x) l(j)) !~
          'SENTINEL|\+1415|zelda\.guest|orgb-secret|secret-body|/fixture|push\.example|Gina|Zelda|@example\.com.*zelda',
  'no body variables, payload, full address or phone, URL path or guest name anywhere in the rows');
select is((select array_agg(a.attname::text order by a.attnum) from pg_attribute a
           where a.attrelid = 'api.platform_delivery_row'::regclass and a.attnum > 0 and not a.attisdropped),
  array['kind', 'id', 'org_id', 'org_name', 'created_at', 'updated_at', 'medium', 'template_key', 'status',
        'delivery_status', 'error_code', 'attempts', 'provider', 'suppression_reason', 'recipient_masked'],
  'column set: exactly the metadata columns, no body, vars, payload, address or contact id');
select is((select array_agg(a.attname::text order by a.attnum) from pg_attribute a
           where a.attrelid = 'api.platform_delivery_summary_row'::regclass and a.attnum > 0 and not a.attisdropped),
  array['medium', 'provider', 'sent', 'failed', 'suppressed', 'pending', 'failure_rate'],
  'column set: the summary is counts only');
select is(private.mask_delivery_recipient('a@b.co'), 'a***@b.co', 'one-letter local part');
select is(private.mask_delivery_recipient('+1'), '******', 'a phone with fewer than three digits shows none');
select is(private.mask_delivery_recipient(''), null, 'blank masks to null');
select is(private.mask_delivery_recipient(null), null, 'null masks to null');

-- Filters ----------------------------------------------------------------------------------------
select tests.as_support();
select is((select count(*) from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 00:00Z', '2026-03-11 00:00Z', 'queued')),
  3::bigint, 'status filter');
select is((select count(*) from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 00:00Z', '2026-03-11 00:00Z', null, 'sms')),
  8::bigint, 'channel filter');
select is((select count(*) from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 00:00Z', '2026-03-11 00:00Z', null, 'webhook')),
  1::bigint, 'channel webhook selects webhook deliveries only');
select is((select count(*) from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 00:00Z', '2026-03-11 00:00Z', 'failed')),
  5::bigint, 'failed covers failed messages and a failed webhook');

-- Paging boundaries ------------------------------------------------------------------------------
select is((select count(*) from tests.all_pages(tests.id('org_a'), 2)), 12::bigint, 'page of 2: 12 rows, including a 3-way timestamp tie');
select is((select count(distinct p) from tests.all_pages(tests.id('org_a'), 2) p), 12::bigint, 'page of 2: no row repeats');
select is((select count(*) from tests.all_pages(tests.id('org_a'), 3)), 12::bigint, 'page size dividing the total evenly: no extra or missing page');
select is((select count(*) from tests.all_pages(tests.id('org_a'), 1)), 12::bigint, 'page of 1 reaches every row');
select is((select count(*) from tests.all_pages(tests.id('org_a'), 200)), 12::bigint, 'page of 200 returns all in one');
select is((select count(*) from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 00:00Z', '2026-03-11 00:00Z', null, null, 1,
           (select created_at from log_a order by created_at, id limit 1), (select id from log_a order by created_at, id limit 1))),
  0::bigint, 'a cursor at the oldest row returns nothing');
select is((select array_agg(id order by created_at desc, id desc) from log_a),
  (select array_agg(id) from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 00:00Z', '2026-03-11 00:00Z')),
  'rows are newest first, ties by id');
select throws_ok($$ select * from api.platform_org_deliveries(tests.id('org_a'), null, null, null, null, 0) $$, 'P0001', 'invalid_input', 'limit 0');
select throws_ok($$ select * from api.platform_org_deliveries(tests.id('org_a'), null, null, null, null, 201) $$, 'P0001', 'invalid_input', 'limit 201');
select throws_ok($$ select * from api.platform_org_deliveries(tests.id('org_a'), null, null, null, null, 10, now(), null) $$, 'P0001', 'invalid_input', 'half a cursor');

select throws_ok($$ select * from api.platform_org_deliveries(tests.id('org_a'), null, null, repeat('x', 33)) $$, 'P0001', 'invalid_input', 'an oversized status filter is refused');

-- Time bounds and time zones ---------------------------------------------------------------------
select is((select count(*) from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 09:00Z', '2026-03-10 09:30Z')), 1::bigint,
  'from is inclusive and to is exclusive');
select throws_ok($$ select * from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 09:00Z', '2026-03-10 09:00Z') $$, 'P0001', 'invalid_input',
  'an empty window is invalid');
set local timezone = 'Pacific/Auckland';
select is((select count(*) from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 09:00Z', '2026-03-10 13:00Z')), 6::bigint,
  'the window is an instant range: the session time zone changes nothing');
select is((select count(*) from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 22:00+13', '2026-03-11 02:00+13')), 6::bigint,
  'the same window written with an offset matches');
reset timezone;

-- Edge tenants -----------------------------------------------------------------------------------
select tests.as_postgres();
insert into app.organizations (id, name) values (tests.new_id('org_empty'), 'Empty org');
select tests.as_support();
select is((select count(*) from api.platform_org_deliveries(tests.id('org_empty'))), 0::bigint, 'an org with no messages: empty, no error');
select throws_ok($$ select * from api.platform_org_deliveries(gen_random_uuid()) $$, 'P0001', 'not_found', 'an unknown org is not_found');
select tests.as_postgres();
update app.organizations set status = 'suspended', suspended_reason = 'test', suspended_at = now() where id = tests.id('org_a');
select tests.as_support();
select is((select count(*) from api.platform_org_deliveries(tests.id('org_a'), '2026-03-10 00:00Z', '2026-03-11 00:00Z')), 12::bigint,
  'a suspended org is still readable by support');
select tests.as_postgres();
select is((select count(*) from app.support_grants where org_id = tests.id('org_a') and revoked_at is null and expires_at > now()), 0::bigint,
  'no live support grant exists, and none was needed (revoked or expired grants change nothing)');

-- All tenants: failures only ----------------------------------------------------------------------
select tests.as_support();
select throws_ok($$ select * from api.platform_org_deliveries(null::uuid, '2026-03-10 00:00Z', '2026-03-11 00:00Z') $$, 'P0001', 'invalid_input',
  'all tenants without a failure status is refused');
select throws_ok($$ select * from api.platform_org_deliveries(null::uuid, null, null, 'sent') $$, 'P0001', 'invalid_input', 'all tenants for sent is refused');
select set_eq($$ select distinct org_id from api.platform_org_deliveries(null::uuid, '2026-03-10 00:00Z', '2026-03-11 00:00Z', 'failed') $$,
  $$ values (tests.id('org_a')), (tests.id('org_b')) $$, 'the failures view spans tenants');

-- Audit --------------------------------------------------------------------------------------------
select tests.as_postgres();
select ok(exists (select 1 from app.platform_audit where action = 'deliveries.read' and org_id = tests.id('org_a')
                  and actor_id = tests.id('support')), 'an org-scoped read is logged with the actor and org id');
select ok(exists (select 1 from app.platform_audit where action = 'deliveries.read' and org_id is null), 'the cross-tenant read is logged without an org');
select ok(not exists (select 1 from app.platform_audit where action = 'deliveries.read' and target::text ~ '\+1415|@|SENTINEL'),
  'audit rows hold counts and filters, never an address');

-- Summary ------------------------------------------------------------------------------------------
select tests.as_support();
select results_eq(
  $$ select medium, provider, sent, failed, suppressed, pending, failure_rate::numeric(3,2)
     from api.platform_delivery_summary('2026-03-10 00:00Z', '2026-03-11 00:00Z') $$,
  $$ values ('email', 'resend', 0, 3, 0, 0, 1.00),
            ('push', 'webpush', 1, 0, 0, 0, 0.00),
            ('sms', 'none', 0, 0, 1, 3, 0.00),
            ('sms', 'twilio', 1, 3, 0, 0, 0.75),
            ('webhook', 'webhook', 0, 1, 0, 0, 1.00) $$,
  'summary by channel and provider across tenants; a window with only pending and suppressed has rate 0');
select is((select count(*) from api.platform_delivery_summary('2000-01-01', '2000-01-02')), 0::bigint, 'an empty window returns no rows');
select tests.as_operator();
select is((select count(*) from api.platform_delivery_summary('2026-03-10 00:00Z', '2026-03-11 00:00Z')), 5::bigint, 'operator reads the summary');
select throws_ok($$ select * from api.platform_delivery_summary(null, now()) $$, 'P0001', 'invalid_input', 'null bound');
select throws_ok($$ select * from api.platform_delivery_summary('2026-03-11', '2026-03-10') $$, 'P0001', 'invalid_input', 'reversed window');
select throws_ok($$ select * from api.platform_delivery_summary('2026-01-01', '2026-03-10') $$, 'P0001', 'invalid_input', 'over 31 days');
select is((select count(*) from api.platform_delivery_summary('2026-02-07 00:00Z', '2026-03-10 00:00Z')), 0::bigint, 'exactly 31 days is allowed');

select * from finish();
rollback;
