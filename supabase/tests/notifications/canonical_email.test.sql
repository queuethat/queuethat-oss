-- #479 follow-up: Proton's domains are one inbox to canonical_email, and the indexes agree.
begin;
\ir ../helpers/_setup.psql
select plan(3);
select tests.create_world();

select results_eq($$ select private.canonical_email(v) from unnest(array[
    'Lee@ProtonMail.com', 'lee+x@pm.me', 'lee@protonmail.ch.', 'lee@proton.me', 'l.ee@proton.me']) v $$,
  $$ values ('lee@proton.me'), ('lee@proton.me'), ('lee@proton.me'), ('lee@proton.me'), ('l.ee@proton.me') $$,
  'Proton domains fold to proton.me; local-part dots stay');

select is(private.canonical_email('lee@protonmail.co'), 'lee@protonmail.co',
  'a look-alike domain is not folded');

-- The suppression index answers with the new canonical form.
set local enable_seqscan = off;
insert into app.suppressions (org_id, channel, value, reason)
values (tests.id('org_a'), 'email', 'lee@pm.me', 'bounce');
select is((select count(*)::int from app.suppressions
           where channel = 'email' and private.canonical_email(value) = private.canonical_email('LEE@protonmail.com')),
  1, 'a bounce on pm.me matches the protonmail.com address');

select * from finish();
rollback;
