-- C3 (#1229): the opt-in text a guest agrees to and the footer of every text say STOP and HELP the same way.
begin;
\ir ../helpers/_setup.psql
select plan(4);

select is_empty($$
  select t.locale from app.consent_texts t
  where t.channel = 'sms' and t.purpose = 'transactional'
    and t.version = (select max(x.version) from app.consent_texts x
                     where x.channel = t.channel and x.purpose = t.purpose and x.locale = t.locale)
    and strpos(t.body, private.sms_footer(t.locale)) = 0 $$,
  'the latest SMS opt-in text of every language contains that language''s latest footer');
select ok((select bool_and(f.text ~ '\mSTOP\M' and f.text ~ '\mHELP\M') from app.sms_footers f
           where f.version = (select max(x.version) from app.sms_footers x where x.locale = f.locale)),
  'every latest footer names STOP and HELP');
select is(private.inbound_keyword_kind('HELP'), 'help', 'HELP, as the footer says, is a help request');
select is(private.inbound_keyword_kind('STOP'), 'optout', 'STOP is an opt-out');

select * from finish();
rollback;
