-- 3-PV7 (#346): usage_alert emails at 80% and 100% of a daily cap.
begin;
\ir ../helpers/_setup.psql
select plan(8);
select tests.create_world();

update app.organizations set created_at = now() - interval '60 days';
update app.channel_limits set daily_cap = 100 where org_id = tests.id('org_a') and channel = 'sms';
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('us'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550188', 'online');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
select tests.new_id('n' || i), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('us'), 'called', 1, 'n' || i
from generate_series(1, 101) i;

create function pg_temp.reserve(p_from int, p_to int) returns void language plpgsql as $$
begin
  for i in p_from..p_to loop perform api.reserve_send(tests.id('n' || i)); end loop;
end $$;
grant all on function pg_temp.reserve(int, int) to service_role;

select tests.as_service();
select pg_temp.reserve(1, 79);
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'usage_alert'), 0, 'below 80% nothing is queued');

select tests.as_service();
select pg_temp.reserve(80, 80);
select tests.as_postgres();
select is((select count(*)::int from app.usage_alerts where org_id = tests.id('org_a') and day = (now() at time zone 'UTC')::date and threshold = 80),
  1, 'AC1: the 80th send records the 80% alert');
select results_eq($$ select m.role::text from app.notifications n join app.memberships m on m.user_id = n.recipient_ref and m.org_id = n.org_id
                     where n.template_key = 'usage_alert' and n.org_id = tests.id('org_a') order by 1 $$,
  $$ values ('admin'), ('owner') $$, 'AC1: one alert per owner and admin, none for managers or staff');

select tests.as_service();
select pg_temp.reserve(81, 81);
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'usage_alert'), 2, 'AC1: the 81st queues none');

select tests.as_service();
select pg_temp.reserve(82, 100);
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'usage_alert' and vars ->> 'percent' = '100'), 2,
  'AC2: the 100th send queues the 100% alerts');
select is((select count(*)::int from app.notifications where template_key = 'usage_alert' and org_id = tests.id('org_b')), 0,
  'AC4: org B never receives org A alerts');

-- AC3 and opt-out: a removed member and an opted-out member get nothing at the next day's threshold.
delete from app.usage_alerts where org_id = tests.id('org_a');
delete from app.notifications where template_key = 'usage_alert';
delete from app.memberships where org_id = tests.id('org_a') and user_id = tests.id('admin');
update app.memberships set notify_usage_alerts = false where org_id = tests.id('org_a') and user_id = tests.id('owner');
select private.enqueue_usage_alert(tests.id('org_a'), 'sms', current_date, 80, 80, 100);
select is((select count(*)::int from app.notifications where template_key = 'usage_alert'), 0,
  'AC3: a removed admin and an opted-out owner are not queued');
update app.memberships set notify_usage_alerts = true where org_id = tests.id('org_a') and user_id = tests.id('owner');
select private.enqueue_usage_alert(tests.id('org_a'), 'sms', current_date, 80, 80, 100);
select is((select count(*)::int from app.notifications where template_key = 'usage_alert'), 1, 'opting back in queues the alert');

select * from finish();
rollback;
