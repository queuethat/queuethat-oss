-- 2B-I7 (#312): the sender owns the backoff; eight attempts; 20 dead deliveries disable the endpoint.
begin;
\ir ../helpers/_setup.psql
select plan(7);
select tests.create_world();

insert into app.webhook_endpoints (id, org_id, url, event_types, vault_secret_id)
values (tests.new_id('ep'), tests.id('org_a'), 'https://example.com/p', array['visit.called'], gen_random_uuid());
insert into app.webhook_deliveries (id, org_id, endpoint_id, event_id, event_type, payload, status, attempts)
values (tests.new_id('d1'), tests.id('org_a'), tests.id('ep'), 'e1', 'visit.called', '{}', 'claimed', 0),
       (tests.new_id('d8'), tests.id('org_a'), tests.id('ep'), 'e8', 'visit.called', '{}', 'claimed', 7);

select tests.as_service();
select api.report_webhook_result(tests.id('d1'), '{"status":"failed","retryable":true,"retry_in_seconds":300}');
select tests.as_postgres();
select is((select status from app.webhook_deliveries where id = tests.id('d1')), 'failed', 'a first failure is retried');
select ok((select next_attempt_at between now() + interval '299 seconds' and now() + interval '301 seconds'
           from app.webhook_deliveries where id = tests.id('d1')), 'at the sender''s retry_in_seconds');
select is((select consecutive_failures from app.webhook_endpoints where id = tests.id('ep')), 0, 'a pending retry does not count against the endpoint');

select tests.as_service();
select api.report_webhook_result(tests.id('d8'), '{"status":"failed","retryable":true,"retry_in_seconds":86400}');
select tests.as_postgres();
select is((select status from app.webhook_deliveries where id = tests.id('d8')), 'dead', 'the eighth failure is dead');
select is((select consecutive_failures from app.webhook_endpoints where id = tests.id('ep')), 1, 'and counts against the endpoint');

update app.webhook_deliveries set status = 'claimed', attempts = 3 where id = tests.id('d1');
select tests.as_service();
select api.report_webhook_result(tests.id('d1'), '{"status":"delivered","attempt":2}');
select tests.as_postgres();
select is((select status from app.webhook_deliveries where id = tests.id('d1')), 'claimed', 'a report from an older claim is ignored');

update app.webhook_endpoints set consecutive_failures = 19 where id = tests.id('ep');
update app.webhook_deliveries set status = 'claimed', attempts = 7 where id = tests.id('d8');
select tests.as_service();
select api.report_webhook_result(tests.id('d8'), '{"status":"failed","retryable":false}');
select tests.as_postgres();
select is((select disabled_reason from app.webhook_endpoints where id = tests.id('ep')), 'too_many_failures',
  'the 20th dead delivery in a row disables the endpoint');

select * from finish();
rollback;
