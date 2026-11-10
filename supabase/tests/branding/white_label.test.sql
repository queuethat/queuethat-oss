-- 4-WL1 (#376): organizations.hide_product_branding is owner-only, public through
-- api.get_location_branding, and reaches the email footer through claim_outbox vars.
begin;
\ir ../helpers/_setup.psql
select plan(7);
select tests.create_world();
update app.locations set tz = (select name from pg_timezone_names where extract(hour from now() at time zone name) = 12 and name !~ '^(posix|Etc|SystemV)' limit 1); -- a clock inside the send window, whatever time CI runs

select tests.as_anon();
select is((select (api.get_location_branding('test-location-a')).hide_product_branding), false, 'default: the product name shows');

select tests.act_as('admin');
select throws_ok(format($$ update app.organizations set hide_product_branding = true where id = %L $$, tests.id('org_a')),
  '42501', 'permission_denied', 'AC2: an admin cannot change the flag');

select tests.act_as('owner');
select lives_ok(format($$ update app.organizations set hide_product_branding = true where id = %L $$, tests.id('org_a')),
  'the owner sets the flag');
select lives_ok(format($$ update app.organizations set name = name where id = %L $$, tests.id('org_a')),
  'an owner or admin update that leaves the flag alone is unaffected');

select tests.as_user(tests.id('other_owner'));
update app.organizations set hide_product_branding = false where id = tests.id('org_a');
select tests.as_postgres();
select is((select hide_product_branding from app.organizations where id = tests.id('org_a')), true,
  'AC2: another org''s owner cannot reach org A''s flag');

select tests.as_anon();
select is((select (api.get_location_branding('test-location-a')).hide_product_branding), true, 'AC1: anon reads the flag');
select tests.as_postgres();

insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category, dedupe_key, vars)
values (tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('contact_a'), 'almost_up', 1, 'transactional', 'wl1',
        '{"org_hide_product_branding": false}');
select is((select j.vars ->> 'org_hide_product_branding' from api.claim_outbox(200, 60) j
           where j.id = (select id from app.notifications where dedupe_key = 'wl1')), 'true',
  'AC1: claim_outbox carries the flag and overwrites a stored value');
select * from finish();
rollback;
