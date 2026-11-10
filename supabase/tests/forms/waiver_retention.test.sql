-- W7 (#1361): waiver evidence has its own tenant retention (default 365, max 2555).
begin;
\ir ../helpers/_setup.psql
select plan(11);
select tests.create_world();

select is((select waiver_retention_days from app.organizations where id = tests.id('org_a')), 365, 'the default is 365 days');

insert into app.waiver_acceptances (org_id, location_id, form_response_id, form_version_id, field_key, text_hash, accepted_at,
                                    subject_kind, subject_id)
select tests.id('org_a'), tests.id('loc_a'), gen_random_uuid(), tests.id('form_version_a'), k, repeat('a', 64),
       now() - make_interval(days => d), 'visit', tests.id('visit_a')
from (values ('old', 400), ('mid', 100), ('older', 2000)) as t (k, d);
delete from app.waiver_acceptances where field_key not in ('old', 'mid', 'older');

select is(ops.waiver_retention_tick(), 2, 'at 365 days the tick deletes the 400 and 2000 day old records');
select is((select string_agg(field_key, ',') from app.waiver_acceptances), 'mid', 'and keeps the recent one');

-- A longer tenant period keeps older evidence (4 to 5).
insert into app.waiver_acceptances (org_id, location_id, form_response_id, form_version_id, field_key, text_hash, accepted_at,
                                    subject_kind, subject_id)
select tests.id('org_a'), tests.id('loc_a'), gen_random_uuid(), tests.id('form_version_a'), k, repeat('b', 64),
       now() - make_interval(days => d), 'visit', tests.id('visit_a')
from (values ('y5', 1800), ('y8', 2900)) as t (k, d);
update app.organizations set waiver_retention_days = 2555 where id = tests.id('org_a');
select is(ops.waiver_retention_tick(), 1, 'at 2555 days only the 8 year old record goes');
select is((select count(*)::int from app.waiver_acceptances where field_key in ('mid', 'y5')), 2, 'the 5 year old record is kept');

-- The setting: bounds (6 to 7), admin only (8 to 9).
select throws_ok($$ update app.organizations set waiver_retention_days = 2556 where id = tests.id('org_a') $$, '23514', null, 'more than 7 years is refused');
select throws_ok($$ update app.organizations set waiver_retention_days = 0 where id = tests.id('org_a') $$, '23514', null, 'zero is refused');
select tests.act_as('staff');
update app.organizations set waiver_retention_days = 30 where id = tests.id('org_a');
select tests.as_postgres();
select is((select waiver_retention_days from app.organizations where id = tests.id('org_a')), 2555, 'staff cannot change it');
select tests.act_as('other_owner');
update app.organizations set waiver_retention_days = 30 where id = tests.id('org_a');
select tests.as_postgres();
select is((select waiver_retention_days from app.organizations where id = tests.id('org_a')), 2555, 'cross-tenant: another org cannot change it');
select tests.act_as('admin');
update app.organizations set waiver_retention_days = 700 where id = tests.id('org_a');
select tests.as_postgres();
select is((select waiver_retention_days from app.organizations where id = tests.id('org_a')), 700, 'an admin sets it');
select is((select waiver_retention_days from app.organizations where id = tests.id('org_b')), 365, 'another tenant keeps its own default');

select * from finish();
rollback;
