-- Privacy audit B4: purging an org deletes the logins of members who belong nowhere else.
begin;
\ir ../helpers/_setup.psql
select plan(12);
select tests.create_world();

select tests.as_postgres();
-- manager also works for org B; admin is held by a cascade key outside app (as a hosted
-- platform role would be); staff authored org B's row through a set-null key only.
insert into app.memberships (org_id, user_id, role) values (tests.id('org_b'), tests.id('manager'), 'staff');
create table tests.platform_hold (user_id uuid primary key references auth.users (id) on delete cascade);
insert into tests.platform_hold values (tests.id('admin'));
update app.organizations set created_by = tests.id('staff') where id = tests.id('org_b');
update app.organizations set created_by = tests.id('owner') where id = tests.id('org_a');

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
select is((select auth_users_deleted from ops.org_deletion_log where org_id = tests.id('org_a')), 2,
  'the log counts deleted logins, without naming them');
select is((select count(*) from auth.identities where user_id in (tests.id('owner'), tests.id('staff'))), 0::bigint,
  'nothing of the deleted logins is left in auth');

select * from finish();
rollback;
