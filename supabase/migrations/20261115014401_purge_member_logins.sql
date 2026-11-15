-- Privacy audit B4 (compliance/privacy.md): org deletion left the owner's and staff's logins
-- (auth.users: email, password hash) behind. The daily purge now deletes the logins whose only
-- hold on the deployment was the purged org. Device logins stay with purge-org.

alter table ops.org_deletion_log add column auth_users_deleted int not null default 0;
comment on column ops.org_deletion_log.auth_users_deleted is
  'Member logins (auth.users) deleted with the org. Kept logins are not counted.';

/**
 * Deletes every row of orgs whose grace period ended, and the org, then logs it without names.
 * Also deletes the auth users of the org's members (and its creator) unless an ON DELETE CASCADE
 * foreign key outside the auth schema still references them, for example a membership in another
 * org. A login that cannot be deleted is kept with a warning; the org is still purged.
 * Contract for extension code: a table whose rows must keep a login alive (for example a hosted
 * operator role) references auth.users ON DELETE CASCADE; set-null keys do not hold a login.
 * Needs the database owner; not callable via the API. Returns orgs purged.
 */
-- redefines ops.purge_deleted_orgs from 20261112094019_extension_hooks_2.sql
create or replace function ops.purge_deleted_orgs()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_due uuid[];
  v_org uuid;
  v_requested timestamptz;
  v_tables text[];
  v_pending text[];
  v_next text[];
  t text;
  n int := 0;
  v_users uuid[];
  v_user uuid;
  v_kept boolean;
  v_fk record;
  v_deleted int;
begin
  select array_agg(c.table_name order by c.table_name) into v_tables
  from information_schema.columns c
  join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
  where c.table_schema = 'app' and c.column_name = 'org_id' and x.table_type = 'BASE TABLE'
    -- Tables the deployment keeps after an org is gone, such as counts keyed by org id.
    and c.table_name <> all (array_remove(coalesce(private.ext_purge_keep_tables(), '{}'), null));

  -- Read up front: the loop below alters tables, which fails while a cursor on them is open.
  -- Orgs whose storage files and device users are not gone yet are handed to purge-org first;
  -- the function reports back through api.mark_org_purged_externally and the next run purges.
  perform private.kick_purge_org(o.id) from app.organizations o
  where o.status = 'pending_deletion' and o.deletion_scheduled_for <= now() and o.external_purged_at is null;
  select coalesce(array_agg(id), '{}') into v_due from app.organizations
  where status = 'pending_deletion' and deletion_scheduled_for <= now() and external_purged_at is not null;
  foreach v_org in array v_due loop
    select deletion_requested_at into v_requested from app.organizations where id = v_org;
    begin -- one org's failure rolls back only that org and leaves the others to purge
    -- Member logins, read before their memberships go (B4): candidates for deletion below.
    select coalesce(array_agg(distinct u), '{}') into v_users from (
      select m.user_id as u from app.memberships m where m.org_id = v_org
      union select o.created_by from app.organizations o where o.id = v_org and o.created_by is not null
    ) s;
    foreach t in array v_tables || 'organizations'::text loop
      execute format('alter table app.%I disable trigger user', t);
    end loop;
    -- Foreign keys stay enforced: a table that still has children is retried after them.
    v_pending := v_tables;
    for i in 1..20 loop
      v_next := '{}';
      foreach t in array v_pending loop
        begin
          execute format('delete from app.%I where org_id = $1', t) using v_org;
        exception when foreign_key_violation then
          v_next := v_next || t;
        end;
      end loop;
      v_pending := v_next;
      exit when cardinality(v_pending) = 0;
    end loop;
    if cardinality(v_pending) > 0 then
      raise exception 'purge_incomplete' using detail = array_to_string(v_pending, ',');
    end if;
    delete from app.organizations where id = v_org;
    foreach t in array v_tables || 'organizations'::text loop
      execute format('alter table app.%I enable trigger user', t);
    end loop;
    -- A login goes with the org unless something still holds it through an ON DELETE CASCADE key
    -- (a membership in another org, a hosted platform role, ...), which would otherwise delete
    -- that row too. Keys are read from the catalog, so tables added later are covered. Set-null
    -- references (authorship columns) are cleared by the delete, as their keys say. This runs after
    -- the triggers are back on, so clearing another org's row goes through its guards; a guard that
    -- refuses keeps the login (warning), never the org purge.
    v_deleted := 0;
    foreach v_user in array v_users loop
      v_kept := false;
      for v_fk in
        select n.nspname as sch, r.relname as tbl, a.attname as col
        from pg_constraint c
        join pg_class r on r.oid = c.conrelid
        join pg_namespace n on n.oid = r.relnamespace
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and c.confrelid = 'auth.users'::regclass and c.confdeltype = 'c'
          and cardinality(c.conkey) = 1 and n.nspname <> 'auth'
      loop
        execute format('select exists (select 1 from %I.%I where %I = $1)', v_fk.sch, v_fk.tbl, v_fk.col)
          into v_kept using v_user;
        exit when v_kept;
      end loop;
      continue when v_kept;
      begin -- one login that cannot go is kept and reported; the org purge still completes
        delete from auth.users where id = v_user;
        delete from private.mfa_failures where user_id = v_user;
        v_deleted := v_deleted + 1;
      exception when others then
        raise warning 'purge_deleted_orgs: org % kept a login: %', v_org, sqlerrm;
      end;
    end loop;
    insert into ops.org_deletion_log (org_id, requested_at, auth_users_deleted)
    values (v_org, v_requested, v_deleted);
    n := n + 1;
    exception when others then
      raise warning 'purge_deleted_orgs: org % failed: %', v_org, sqlerrm;
    end;
  end loop;
  return n;
end $function$;

comment on function ops.purge_deleted_orgs() is
  'Daily: deletes orgs whose deletion date passed (after purge-org removed their files and device '
  'logins), every row they own, and the logins of members who belong to no other org. Logs ids and '
  'counts only. Returns orgs purged.';
