-- Privacy audit B4: purging an org deletes the logins of members who belong nowhere else.
begin;
\ir ../helpers/_setup.psql
select plan(15);
select tests.create_world();

select tests.as_postgres();
-- manager also works for org B; admin is held by a cascade key outside app (as a hosted
-- platform role would be); staff authored org B's row through a set-null key only.
insert into app.memberships (org_id, user_id, role) values (tests.id('org_b'), tests.id('manager'), 'staff');
create table tests.platform_hold (user_id uuid primary key references auth.users (id) on delete cascade);
insert into tests.platform_hold values (tests.id('admin'));
update app.organizations set created_by = tests.id('staff') where id = tests.id('org_b');
update app.organizations set created_by = tests.id('owner') where id = tests.id('org_a');
-- leaver left org B but still holds a visit there (set-null key on a guarded table).
select tests.create_user('leaver');
insert into app.memberships (org_id, user_id, role) values (tests.id('org_a'), tests.id('leaver'), 'staff');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Walk-ins', 'B');
select private.set_actor('system', null);
select tests.new_visit('visit_b', 'queue_b');
update app.visits set assigned_staff_id = tests.id('leaver') where id = tests.id('visit_b');
create temp table events_before as
  select count(*) as n from app.visit_events where visit_id = tests.id('visit_b');
insert into private.mfa_failures (user_id) values (tests.id('owner'));

update app.organizations set status = 'pending_deletion', deletion_requested_at = now() - interval '8 days',
  deletion_scheduled_for = now() - interval '1 minute', external_purged_at = now()
where id = tests.id('org_a');

select is(ops.purge_deleted_orgs(), 1, 'the org is purged');

select is((select count(*) from auth.users where id = tests.id('owner')), 0::bigint,
  'the owner, a member of the purged org only, loses their login');
select is((select count(*) from auth.users where id = tests.id('staff')), 0::bigint,
  'so does staff, although org B named them as its creator (set-null key)');
select is((select created_by from app.organizations where id = tests.id('org_b')), null::uuid,
  'org B''s authorship column is cleared, not its row');
select is((select count(*) from auth.users where id = tests.id('manager')), 1::bigint,
  'a member of another org keeps their login');
select is((select count(*) from app.memberships where user_id = tests.id('manager') and org_id = tests.id('org_b')), 1::bigint,
  'and their membership there');
select is((select count(*) from auth.users where id = tests.id('admin')), 1::bigint,
  'a login another table holds through a cascade key is kept');
select is((select count(*) from tests.platform_hold), 1::bigint, 'and that row survives');
select is((select count(*) from auth.users where id = tests.id('other_owner')), 1::bigint,
  'org B''s owner is untouched (cross-tenant)');
select is((select count(*) from auth.users where id in (tests.id('display'), tests.id('kiosk'))), 2::bigint,
  'device logins are left to purge-org');
select is((select auth_users_deleted from ops.org_deletion_log where org_id = tests.id('org_a')), 3,
  'the log counts deleted logins, without naming them');
select is((select count(*) from auth.identities where user_id in (tests.id('owner'), tests.id('staff'))), 0::bigint,
  'nothing of the deleted logins is left in auth');

select is((select count(*) from private.mfa_failures where user_id = tests.id('owner')), 0::bigint,
  'the deleted owner''s MFA failure rows go too');
select ok((select assigned_staff_id from app.visits where id = tests.id('visit_b')) is null
          and (select count(*) from app.visit_events where visit_id = tests.id('visit_b')) > (select n from events_before),
  'a leaver''s login goes, and org B''s visit is cleared through its triggers with an event (I-1)');
select is((select count(*) from app.visits where id = tests.id('visit_b')), 1::bigint,
  'org B''s visit still exists');

select * from finish();
rollback;
