-- 2B-I1 (#306): hashed, scoped API keys per org. Replaces the stub bodies of api.create_api_key and
-- redefines api.create_api_key from 20261030162713_api_contracts_2b.sql
-- redefines api.revoke_api_key from 20261030162713_api_contracts_2b.sql
-- api.revoke_api_key and adds private.authenticate_api_key. Signatures and return types are fixed
-- by 20261030162713_api_contracts_2b.sql.
--
-- Key format: qk_live_<prefix8>_<secret32>. The prefix is stored (lookup and display); the secret
-- only as SHA-256. Keys are high entropy (128 bits), so a fast hash is enough.

create table app.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  prefix text not null unique check (prefix ~ '^[0-9a-f]{8}$'),
  secret_hash bytea not null check (length(secret_hash) = 32),
  scopes text[] not null check (
    cardinality(scopes) > 0
    and scopes <@ array['queues:read', 'queues:write', 'visits:read', 'visits:write',
                        'analytics:read', 'webhooks:manage']::text[]),
  -- null = every location of the org
  location_ids uuid[] check (location_ids is null or cardinality(location_ids) > 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_org_idx on app.api_keys (org_id, created_at desc);

create trigger forbid_org_change before update on app.api_keys
  for each row execute function private.forbid_org_change();

alter table app.api_keys enable row level security;

-- Owners and admins read metadata; every write goes through the RPCs below.
create policy api_keys_select on app.api_keys for select to authenticated
  using ((select private.has_role(org_id, null, 'admin')));

-- secret_hash is never readable by a client.
revoke all on app.api_keys from public, anon, authenticated;
grant select (id, org_id, name, prefix, scopes, location_ids, created_by, created_at,
              last_used_at, expires_at, revoked_at)
  on app.api_keys to authenticated;

-- Audit without the hash: the generic audit_row would copy secret_hash into app.audit_log.
create function private.audit_api_key() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  row_new jsonb := to_jsonb(new) - 'secret_hash';
  row_old jsonb := to_jsonb(old) - 'secret_hash';
begin
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, before, after)
  values (
    coalesce(new.org_id, old.org_id), uid,
    coalesce((select m.role::text from app.memberships m
              where m.user_id = uid and m.org_id = coalesce(new.org_id, old.org_id)), 'system'),
    tg_op, tg_table_name, coalesce(new.id, old.id)::text,
    case when tg_op <> 'INSERT' then row_old end,
    case when tg_op <> 'DELETE' then row_new end);
  return null;
end $$;
comment on function private.audit_api_key() is
  'AFTER trigger on app.api_keys: audit_row without secret_hash. last_used_at touches are not audited.';

create trigger audit_api_key after insert or delete on app.api_keys
  for each row execute function private.audit_api_key();
create trigger audit_api_key_update after update on app.api_keys
  for each row
  when ((to_jsonb(old) - 'last_used_at') is distinct from (to_jsonb(new) - 'last_used_at'))
  execute function private.audit_api_key();

------------------------------------------------------------------------------------------------
-- Helpers
------------------------------------------------------------------------------------------------

create function private.bytea_equal_ct(a bytea, b bytea) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  diff int := length(a) # length(b);
begin
  for i in 0 .. least(length(a), length(b)) - 1 loop
    diff := diff | (get_byte(a, i) # get_byte(b, i));
  end loop;
  return diff = 0;
end $$;
comment on function private.bytea_equal_ct(bytea, bytea) is
  'Compares two byte strings without stopping at the first difference.';

create function private.key_row(k app.api_keys) returns api.api_key_row
language sql immutable set search_path = '' as $$
  select k.id, k.org_id, k.name, k.prefix, k.scopes, k.location_ids, k.created_at, k.last_used_at,
         k.expires_at, k.revoked_at
$$;

-- Admin of the whole org (location_ids null) or of every named location. Not a member: not_found.
create function private.require_key_admin(p_org_id uuid, p_location_ids uuid[]) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  loc uuid;
begin
  if not exists (select 1 from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = p_org_id) then
    raise exception 'not_found';
  end if;
  if not private.has_role(p_org_id, null, 'admin') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_location_ids is null then
    if not exists (select 1 from app.memberships m
                   where m.user_id = (select auth.uid()) and m.org_id = p_org_id
                     and m.role >= 'admin' and m.location_ids is null) then
      raise exception 'permission_denied' using errcode = '42501';
    end if;
  else
    foreach loc in array p_location_ids loop
      if not exists (select 1 from app.locations l where l.id = loc and l.org_id = p_org_id) then
        raise exception 'not_found';
      end if;
      if not private.has_role(p_org_id, loc, 'admin') then
        raise exception 'permission_denied' using errcode = '42501';
      end if;
    end loop;
  end if;
end $$;
comment on function private.require_key_admin(uuid, uuid[]) is
  'Owner or admin of the org, and of every location the key will cover. Non-members get not_found.';

------------------------------------------------------------------------------------------------
-- Authentication (used by the api_v1 endpoints)
------------------------------------------------------------------------------------------------

create function private.authenticate_api_key(p_raw text)
returns table (org_id uuid, key_id uuid, scopes text[], location_ids uuid[])
language plpgsql volatile security definer set search_path = '' as $$
declare
  parts text[] := regexp_match(coalesce(p_raw, ''), '^qk_([a-z]{1,8})_([0-9a-f]{8})_([0-9a-f]{32})$');
  k app.api_keys;
begin
  if parts is not null then
    select * into k from app.api_keys a where a.prefix = parts[2];
  end if;
  -- Unknown, malformed, wrong secret, revoked and expired all fail the same way.
  if parts is null or k.id is null
     or not private.bytea_equal_ct(k.secret_hash, extensions.digest(p_raw, 'sha256'))
     or k.revoked_at is not null or (k.expires_at is not null and k.expires_at <= now())
     or exists (select 1 from app.organizations o where o.id = k.org_id and o.status <> 'active') then
    raise exception 'unauthorized';
  end if;
  update app.api_keys a set last_used_at = now()
  where a.id = k.id and (a.last_used_at is null or a.last_used_at < now() - interval '1 minute');
  return query select k.org_id, k.id, k.scopes, k.location_ids;
end $$;
comment on function private.authenticate_api_key(text) is
  'Resolves a raw API key to (org_id, key_id, scopes, location_ids). Raises unauthorized, with the '
  'same message, for malformed, unknown, wrong-secret, revoked and expired keys. Touches '
  'last_used_at at most once a minute. Never callable by clients.';
revoke all on function private.authenticate_api_key(text) from public, anon, authenticated;
revoke all on function private.bytea_equal_ct(bytea, bytea), private.key_row(app.api_keys),
  private.require_key_admin(uuid, uuid[]), private.audit_api_key() from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- RPCs
------------------------------------------------------------------------------------------------

create or replace function api.create_api_key(p_org_id uuid, p_name text, p_scopes text[], p_location_ids uuid[], p_expires_at timestamptz, p_idempotency_key uuid) returns api.api_key_created
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  result api.api_key_created;
  secret text;
  claimed int;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  perform private.require_key_admin(p_org_id, p_location_ids);
  if p_idempotency_key is null or p_name is null or length(btrim(p_name)) not between 1 and 80
     or (p_expires_at is not null and p_expires_at <= now())
     or (p_location_ids is not null and cardinality(p_location_ids) = 0) then
    raise exception 'invalid_input';
  end if;
  if p_scopes is null or cardinality(p_scopes) = 0 or exists (
       select 1 from unnest(p_scopes) s
       where s is null or s <> all (array['queues:read', 'queues:write', 'visits:read',
                                          'visits:write', 'analytics:read', 'webhooks:manage'])) then
    raise exception 'invalid_scope';
  end if;

  insert into app.idempotency_keys (org_id, actor_id, rpc, key)
  values (p_org_id, uid, 'create_api_key', p_idempotency_key)
  on conflict do nothing;
  get diagnostics claimed = row_count;
  if claimed = 0 then
    -- A repeat never sees the plaintext: it was never stored.
    select r.key_id, r.prefix, null::text into result
    from app.idempotency_keys k, lateral jsonb_populate_record(null::api.api_key_created, k.response) r
    where k.actor_id = uid and k.rpc = 'create_api_key' and k.key = p_idempotency_key
      and k.org_id = p_org_id;
    return result;
  end if;

  secret := encode(extensions.gen_random_bytes(16), 'hex');
  loop
    result.prefix := encode(extensions.gen_random_bytes(4), 'hex');
    result.plaintext_key := 'qk_live_' || result.prefix || '_' || secret;
    begin
      insert into app.api_keys (org_id, name, prefix, secret_hash, scopes, location_ids, created_by, expires_at)
      values (p_org_id, btrim(p_name), result.prefix, extensions.digest(result.plaintext_key, 'sha256'),
              p_scopes, p_location_ids, uid, p_expires_at)
      returning id into result.key_id;
      exit;
    exception when unique_violation then
      null; -- prefix taken; draw again
    end;
  end loop;

  update app.idempotency_keys
  set response = jsonb_build_object('key_id', result.key_id, 'prefix', result.prefix)
  where actor_id = uid and rpc = 'create_api_key' and key = p_idempotency_key;
  return result;
end $$;
comment on function api.create_api_key(uuid, text, text[], uuid[], timestamptz, uuid) is
  'Creates a scoped API key and returns the plaintext once; only its SHA-256 is stored, so a repeat '
  'with the same idempotency key returns the same key_id and prefix with a null plaintext_key. '
  'location_ids null covers every location. Owner or admin of the org (and of each named location). '
  'Raises not_found for a non-member or a foreign location, permission_denied for a manager or '
  'staff, invalid_scope for an unknown scope, invalid_input for a bad name or past expiry.';

create or replace function api.revoke_api_key(p_key_id uuid) returns api.api_key_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  k app.api_keys;
begin
  select * into k from app.api_keys where id = p_key_id for update;
  if not found then raise exception 'not_found'; end if;
  perform private.require_key_admin(k.org_id, null);
  if k.revoked_at is null then
    update app.api_keys set revoked_at = now() where id = k.id returning * into k;
  end if;
  return private.key_row(k);
end $$;
comment on function api.revoke_api_key(uuid) is
  'Revokes a key at once; revoking twice is a no-op that returns the row. Raises not_found for an '
  'unknown or foreign key, permission_denied for a manager or staff.';
