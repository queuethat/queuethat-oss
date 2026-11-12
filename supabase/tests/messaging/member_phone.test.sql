-- S2b (#1389): a member confirms their own phone with a code and sends themselves a framed test text.
begin;
\ir ../helpers/_setup.psql
select plan(27);
select tests.create_world();
create function tests.last_code() returns text language sql security definer as $$
  select n.vars ->> 'code' from app.notifications n join app.member_phones mp on mp.id = n.recipient_ref
  where mp.user_id = tests.id('manager') and n.template_key = 'member_verify' order by n.created_at desc, n.id desc limit 1 $$;
grant execute on function tests.last_code() to authenticated;

-- Start ------------------------------------------------------------------------------------------------
select tests.act_as('manager');
select lives_ok($$ select api.start_member_phone(tests.id('org_a'), '+1 (415) 555-0123') $$, 'a manager saves a number');
select is((select (phone_e164, verified_at is null)::text from app.member_phones where user_id = tests.id('manager')),
  '(+14155550123,t)', 'stored as E.164, not yet confirmed');
select throws_ok($$ select code_hash from app.member_phones $$, '42501', null, 'the code hash is not readable');
select tests.as_postgres();
select is((select count(*)::int from app.notifications n where n.org_id = tests.id('org_a') and n.template_key = 'member_verify'
           and n.channel = 'sms' and n.visit_id is null and n.vars ? 'code'), 1, 'one code text is queued through the outbox');
select ok(tests.last_code() ~ '^[0-9]{6}$', 'the code is six digits');

-- Confirm ----------------------------------------------------------------------------------------------
select tests.act_as('manager');
select is(api.confirm_member_phone(tests.id('org_a'), '000000x'), false, 'a wrong code is false');
select is((select verified_at is null from app.member_phones where user_id = tests.id('manager')), true, 'and confirms nothing');
select is(api.confirm_member_phone(tests.id('org_a'), tests.last_code()), true, 'the right code confirms');
select isnt((select verified_at from app.member_phones where user_id = tests.id('manager')), null, 'the phone is confirmed');
select throws_ok($$ select api.confirm_member_phone(tests.id('org_a'), '123456') $$, 'P0001', 'not_found', 'no code is pending after that');

-- A different number must be confirmed again; the same one keeps its confirmation.
select api.start_member_phone(tests.id('org_a'), '+14155550123');
select isnt((select verified_at from app.member_phones where user_id = tests.id('manager')), null, 'resending to the same number keeps it confirmed');
select tests.as_postgres();
update app.notifications set created_at = now() - interval '2 days' where template_key = 'member_verify';
select tests.act_as('manager');
select api.start_member_phone(tests.id('org_a'), '+14155550124');
select is((select verified_at from app.member_phones where user_id = tests.id('manager')), null, 'a new number is unconfirmed');
select tests.as_postgres();
update app.member_phones set code_attempts = 5 where user_id = tests.id('manager');
select tests.act_as('manager');
select throws_ok($$ select api.confirm_member_phone(tests.id('org_a'), tests.last_code()) $$, 'P0001', 'code_expired', 'five wrong tries end the code');
select tests.as_postgres();
update app.member_phones set code_attempts = 0, code_expires_at = now() - interval '1 second' where user_id = tests.id('manager');
select tests.act_as('manager');
select throws_ok($$ select api.confirm_member_phone(tests.id('org_a'), tests.last_code()) $$, 'P0001', 'code_expired', 'so does ten minutes');

-- Caps and checks --------------------------------------------------------------------------------------
select api.start_member_phone(tests.id('org_a'), '+14155550124');
select api.start_member_phone(tests.id('org_a'), '+14155550124');
select throws_ok($$ select api.start_member_phone(tests.id('org_a'), '+14155550124') $$, 'P0001', 'rate_limited', 'three codes a day per member');
select throws_ok($$ select api.start_member_phone(tests.id('org_a'), '555-0100') $$, 'P0001', 'invalid_input', 'a number without a country code is refused');
select tests.act_as('staff');
select throws_ok($$ select api.start_member_phone(tests.id('org_a'), '+14155550125') $$, '42501', 'permission_denied', 'staff cannot');
select tests.act_as('other_owner');
select throws_ok($$ select api.start_member_phone(tests.id('org_a'), '+14155550125') $$, '42501', 'permission_denied', 'another org''s owner cannot (cross-tenant)');
select throws_ok($$ select api.send_member_test_sms(tests.id('org_a'), 'called') $$, '42501', 'permission_denied', 'nor send a test into it');
select is_empty($$ select 1 from app.member_phones $$, 'nor read org A''s phones');
select tests.as_anon();
select throws_ok($$ select api.start_member_phone(tests.id('org_a'), '+14155550125') $$, '42501', null, 'anon cannot execute');

-- Test text ----------------------------------------------------------------------------------------------
select tests.act_as('manager');
select throws_ok($$ select api.send_member_test_sms(tests.id('org_a'), 'called') $$, 'P0001', 'phone_not_verified', 'an unconfirmed phone gets no test');
select tests.act_as('owner');
select throws_ok($$ select api.send_member_test_sms(tests.id('org_a'), 'served') $$, 'P0001', 'invalid_trigger', 'only the editable guest alerts');
select lives_ok($$ select api.send_member_test_sms(tests.id('org_a'), 'almost_up') $$, 'the owner (confirmed fixture phone) sends a test');

-- The claim frames it, addresses it to the member's phone, and counts it consented.
select tests.as_postgres();
create temp table claimed as select * from api.claim_outbox(200, 60);
select is((select body from claimed where template_key = 'almost_up' and visit_id is null),
  (select private.sms_compose(t.body, 'en') from private.resolve_template(tests.id('org_a'), null, 'almost_up', 'sms', 'en') t),
  'the test text is framed exactly as a guest''s');
select is((select recipient ->> 'value' from claimed where template_key = 'almost_up' and visit_id is null), '+14155550100',
  'it goes to the member''s confirmed phone');
select is((select (has_consent, vars ->> 'ticket')::text from claimed where template_key = 'almost_up' and visit_id is null),
  '(t,A-123)', 'consented, with sample values');

select * from finish();
rollback;
