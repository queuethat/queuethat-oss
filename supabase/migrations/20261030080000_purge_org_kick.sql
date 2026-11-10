-- 2P-PRV8 (#195): storage files and device auth users live outside app tables, so the SQL purge
-- cannot reach them. The Edge Function purge-org (service role only inside it) removes them first.
-- ops.purge_deleted_orgs asks for it through pg_net and purges rows only after the function has
-- reported back (organizations.external_purged_at); a failed call is retried by the next daily run.

alter table app.organizations add column external_purged_at timestamptz;

create function api.org_purge_targets(p_org_id uuid) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.organizations o where o.id = p_org_id and o.status = 'pending_deletion'
                 and o.deletion_scheduled_for <= now()) then
    raise exception 'not_found';
  end if;
  return coalesce((select array_agg(d.auth_user_id) from app.devices d
                   where d.org_id = p_org_id and d.auth_user_id is not null), '{}');
end $$;
comment on function api.org_purge_targets(uuid) is
  'Service role only (purge-org): the auth user ids of the org''s devices, for an org whose deletion '
  'date has passed. Raises not_found for any other org, so the function can never be pointed at a live one.';

create function api.mark_org_purged_externally(p_org_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update app.organizations set external_purged_at = now()
  where id = p_org_id and status = 'pending_deletion' and deletion_scheduled_for <= now();
  if not found then
    raise exception 'not_found';
  end if;
end $$;
comment on function api.mark_org_purged_externally(uuid) is
  'Service role only (purge-org): records that the org''s storage objects and device users are gone, '
  'which lets ops.purge_deleted_orgs delete its rows. Raises not_found unless the deletion date has passed.';

revoke all on function api.org_purge_targets(uuid), api.mark_org_purged_externally(uuid) from public, anon, authenticated;
grant execute on function api.org_purge_targets(uuid), api.mark_org_purged_externally(uuid) to service_role;

create function private.kick_purge_org(p_org_id uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_url text;
  v_key text;
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'purge_org_url';
  if v_url is null then
    select replace(s.decrypted_secret, 'dispatch-notifications', 'purge-org') into v_url
    from vault.decrypted_secrets s where s.name = 'dispatcher_url';
  end if;
  if v_url is null then
    return;
  end if;
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'dispatcher_key';
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('org_id', p_org_id),
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || coalesce(v_key, ''))
  );
exception when others then
  raise warning 'kick_purge_org failed: %', sqlerrm;
end $$;
comment on function private.kick_purge_org(uuid) is
  'Asks purge-org to remove an org''s storage files and device users. Vault secrets purge_org_url '
  '(default: dispatcher_url with the function name swapped) and dispatcher_key. Never raises.';
revoke all on function private.kick_purge_org(uuid) from public, anon, authenticated;

/**
 * Deletes every row of orgs whose grace period ended, and the org, then logs it without names.
 * The only hard delete of visits. Needs the database owner (it switches the append-only and audit
 * triggers off for the tables it empties, inside its own transaction); not callable via the API.
 * Holds locks on every tenant table until it commits (that is what keeps other writers out of
 * the trigger-free window), so it runs once a day at a quiet hour. A failing org is skipped with a
 * warning and retried the next day. Not purged: private.* logs (they expire on their own), auth
 * users (api: purge-org, #195). Returns orgs purged.
 */
-- redefines ops.purge_deleted_orgs from 20261030074500_org_deletion.sql
create or replace function ops.purge_deleted_orgs() returns int
language plpgsql volatile set search_path = '' as $$
declare
  v_due uuid[];
  v_org uuid;
  v_requested timestamptz;
  v_tables text[];
  v_pending text[];
  v_next text[];
  t text;
  n int := 0;
begin
  select array_agg(c.table_name order by c.table_name) into v_tables
  from information_schema.columns c
  join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
  where c.table_schema = 'app' and c.column_name = 'org_id' and x.table_type = 'BASE TABLE';

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
    insert into ops.org_deletion_log (org_id, requested_at) values (v_org, v_requested);
    n := n + 1;
    exception when others then
      raise warning 'purge_deleted_orgs: org % failed: %', v_org, sqlerrm;
    end;
  end loop;
  return n;
end $$;
comment on function ops.purge_deleted_orgs() is
  'Daily: removes orgs past their deletion date (see body). Returns orgs purged.';

