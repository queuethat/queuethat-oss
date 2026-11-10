-- 4-BILL2 (#378): the billing page reads one owner-only function; non-owners get nothing.
begin;
\ir ../helpers/_setup.psql
select plan(27);
select tests.create_world();

select tests.act_as('owner');
select is((select enabled from api.org_billing(tests.id('org_a'))), false, 'AC1: billing off => enabled=false');
select is((select plan_id from api.org_billing(tests.id('org_a'))), null, 'and nothing else is shown');
select throws_ok(format('select * from api.billing_session_info(%L)', tests.id('org_a')), 'P0001', 'not_found',
  'no portal or checkout session while billing is off');

select tests.as_postgres();
update app.platform_flags set billing_enabled = true;
update app.plans set stripe_price_id = 'price_std' where id = 'standard';
update app.subscriptions set stripe_customer_id = 'cus_a', stripe_subscription_id = 'sub_a', current_period_end = '2026-12-01'
where org_id = tests.id('org_a');
insert into app.locations (org_id, name, slug, tz) values (tests.id('org_a'), 'Second', 'bp-second', 'UTC');

select tests.act_as('owner');
select is((select plan_id || '/' || locations || '/' || subscribed || '/' || unit_price_minor from api.org_billing(tests.id('org_a'))),
  'standard/2/true/1900', 'the owner sees plan, locations, price and that Stripe holds a subscription');
select is((select current_period_end from api.org_billing(tests.id('org_a'))), '2026-12-01'::timestamptz, 'and the next invoice date');
select is((select customer_id || '/' || subscription_id || '/' || price_id || '/' || quantity from api.billing_session_info(tests.id('org_a'))),
  'cus_a/sub_a/price_std/2', 'the session info carries the customer, subscription, price and quantity');

-- #1082: the plan comparison comes from the database, limits and price included.
select is((select jsonb_array_length(plans) from api.org_billing(tests.id('org_a'))), 2, 'both plans are listed');
select is((select plans -> 0 ->> 'id' || '/' || (plans -> 0 ->> 'unitPriceMinor') || '/' || (plans -> 0 ->> 'maxLocations') || '/' || (plans -> 0 ->> 'maxMembers') || '/' || (plans -> 0 ->> 'paidChannels')
  from api.org_billing(tests.id('org_a'))), 'free/0/1/3/false', 'free: price 0, 1 location, 3 seats, no paid channels');
select is((select plans -> 1 ->> 'id' || '/' || (plans -> 1 ->> 'unitPriceMinor') || '/' || (plans -> 1 ->> 'maxLocations') || '/' || (plans -> 1 ->> 'maxMembers') || '/' || (plans -> 1 ->> 'paidChannels')
  from api.org_billing(tests.id('org_a'))), 'standard/1900/-1/-1/true', 'standard: price from app.plans, unlimited, paid channels');
select is((select paid_channels from api.org_billing(tests.id('org_a'))), true, 'a subscribed org may use paid channels');

-- #1085: annual pricing is offered once the plan has an annual Stripe Price.
select is((select plans -> 1 -> 'unitPriceAnnualMinor' from api.org_billing(tests.id('org_a'))), 'null'::jsonb,
  'no annual price is offered until its Stripe Price is configured');
select tests.as_postgres();
update app.plans set stripe_price_id_annual = 'price_std_year' where id = 'standard';
select tests.act_as('owner');
select is((select (plans -> 1 ->> 'unitPriceAnnualMinor')::int from api.org_billing(tests.id('org_a'))), 18240,
  'then Standard offers $182.40 per location per year (20% off twelve months)');
select is((select price_id from api.billing_session_info(tests.id('org_a'), 'year')), 'price_std_year', 'Checkout for the year uses the annual Price');
select is((select price_id from api.billing_session_info(tests.id('org_a'))), 'price_std', 'and defaults to the monthly one');
select throws_ok(format('select * from api.billing_session_info(%L, %L)', tests.id('org_a'), 'week'), 'P0001', 'invalid_input', 'any other interval is refused');
select tests.as_postgres();
select is(api.apply_billing_event('subscription', now() + interval '1 hour', null, 'cus_a', 'sub_a', 'active', 'price_std_year', 2, null), 'applied', 'a webhook with the annual Price applies');
select tests.act_as('owner');
select is((select plan_id || '/' || billing_interval from api.org_billing(tests.id('org_a'))), 'standard/year', 'the plan is Standard and billed yearly');
select tests.as_postgres();
select is(api.apply_billing_event('subscription', now() + interval '2 hours', null, 'cus_a', 'sub_a', 'active', 'price_std', 2, null), 'applied', 'switching back to the monthly Price applies');
select tests.act_as('owner');
select is((select billing_interval from api.org_billing(tests.id('org_a'))), 'month', 'and the interval follows');

-- AC2: nobody but an owner can open a session or read the page.
select tests.act_as('admin');
select throws_ok(format('select * from api.org_billing(%L)', tests.id('org_a')), '42501', null, 'an admin cannot read the page data');
select throws_ok(format('select * from api.billing_session_info(%L)', tests.id('org_a')), '42501', null, 'AC2: an admin cannot get a session');
select tests.act_as('staff');
select throws_ok(format('select * from api.billing_session_info(%L)', tests.id('org_a')), '42501', null, 'staff cannot get a session');
select tests.act_as('other_owner');
select throws_ok(format('select * from api.billing_session_info(%L)', tests.id('org_a')), '42501', null, 'another org''s owner cannot get a session');
select throws_ok(format('select * from api.org_billing(%L)', tests.id('org_a')), '42501', null, 'nor read the page data');
select tests.as_anon();
select throws_ok(format('select * from api.org_billing(%L)', tests.id('org_a')), '42501', null, 'anon cannot call it');

-- A free org (no subscription) still gets a page: the free plan and no Stripe state.
select tests.act_as('other_owner');
select is((select plan_id || '/' || subscribed from api.org_billing(tests.id('org_b'))), 'free/false', 'an org without a subscription is on the free plan');

select is((select paid_channels from api.org_billing(tests.id('org_b'))), false, 'a free org may not, so the page hides the SMS credit card');

select * from finish();
rollback;
