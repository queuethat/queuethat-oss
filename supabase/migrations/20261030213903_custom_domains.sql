-- 3-DOM1 (#370): custom domains for guest pages. An org claims a hostname, proves it with a DNS TXT
-- record, and the platform (the TLS layer, the SPA) asks whether a host is verified and which
-- location it serves. A custom domain is an alias: /q/{slug} and /v/{token} stay as they are (I-10).
-- Replaces the stub bodies of api.add_custom_domain and api.remove_custom_domain from
-- 20261030210404_api_contracts_3.sql; signatures and the return type are fixed there.
-- redefines api.add_custom_domain from 20261030210404_api_contracts_3.sql
-- redefines api.remove_custom_domain from 20261030210404_api_contracts_3.sql

create table app.custom_domains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  hostname text not null unique check (hostname = lower(hostname) and length(hostname) <= 253),
  default_location_id uuid not null,
  verification_token text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  status text not null default 'pending' check (status in ('pending', 'verified', 'failed', 'disabled')),
  verified_at timestamptz,
  last_checked_at timestamptz,
  failed_checks int not null default 0 check (failed_checks >= 0),
  created_at timestamptz not null default now(),
  foreign key (org_id, default_location_id) references app.locations (org_id, id) on delete cascade
);
create index custom_domains_org_idx on app.custom_domains (org_id);

create trigger forbid_org_change before update on app.custom_domains
  for each row execute function private.forbid_org_change();

alter table app.custom_domains enable row level security;

-- Owners and admins read; every write goes through the RPCs below. The token is the public DNS
-- TXT value, not a secret.
create policy custom_domains_select on app.custom_domains for select to authenticated
  using ((select private.has_role(org_id, null, 'admin')));
revoke all on app.custom_domains from public, anon, authenticated;
grant select on app.custom_domains to authenticated;

-- The daily re-check touches last_checked_at and failed_checks on every row; that is not audited.
create trigger audit_row after insert or delete on app.custom_domains
  for each row execute function private.audit_row();
create trigger audit_row_update after update on app.custom_domains
  for each row
  when ((to_jsonb(old) - 'last_checked_at' - 'failed_checks') is distinct from (to_jsonb(new) - 'last_checked_at' - 'failed_checks'))
  execute function private.audit_row();

create function private.domain_row(d app.custom_domains) returns api.custom_domain_row
language sql immutable set search_path = '' as $$
  select d.id, d.org_id, d.hostname, d.default_location_id, d.verification_token, d.status,
         d.verified_at, d.last_checked_at
$$;

-- Lower-case ASCII (punycode for IDNA; the client converts), 2+ labels, a letter-initial TLD (so no
-- IP literals), at most 253 characters, and never ours, a platform host or a special-use name.
create function private.normalize_hostname(p_hostname text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  h text := regexp_replace(lower(btrim(coalesce(p_hostname, ''))), '\.$', '');
begin
  if length(h) > 253
     or h !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
     or h ~ '(^|\.)(localhost|local|internal|invalid|test|example|onion|lan|home|arpa)$'
     or h ~ '(^|\.)(queuethat\.com|supabase\.co|supabase\.in|vercel\.app)$' then
    raise exception 'invalid_input';
  end if;
  return h;
end $$;
comment on function private.normalize_hostname(text) is
  'Returns the canonical hostname or raises invalid_input (IP, non-ASCII, too long, malformed, reserved).';

revoke all on function private.domain_row(app.custom_domains), private.normalize_hostname(text)
  from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- RPCs
------------------------------------------------------------------------------------------------

-- redefines api.add_custom_domain from 20261030210404_api_contracts_3.sql
create or replace function api.add_custom_domain(p_org_id uuid, p_hostname text, p_location_id uuid, p_idempotency_key uuid) returns api.custom_domain_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  h text;
  d app.custom_domains;
  claimed int;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  perform private.require_key_admin(p_org_id, array[p_location_id]);
  if p_idempotency_key is null then raise exception 'invalid_input'; end if;
  h := private.normalize_hostname(p_hostname);

  insert into app.idempotency_keys (org_id, actor_id, rpc, key)
  values (p_org_id, uid, 'add_custom_domain', p_idempotency_key)
  on conflict do nothing;
  get diagnostics claimed = row_count;
  if claimed = 0 then
    select c.* into d from app.idempotency_keys k
    join app.custom_domains c on c.id = (k.response ->> 'id')::uuid and c.org_id = p_org_id
    where k.actor_id = uid and k.rpc = 'add_custom_domain' and k.key = p_idempotency_key;
    if found then return private.domain_row(d); end if;
    -- The domain was removed since: fall through and add it again.
  end if;

  select * into d from app.custom_domains where hostname = h for update;
  if found then
    if d.org_id = p_org_id then
      update app.idempotency_keys set response = jsonb_build_object('id', d.id)
      where actor_id = uid and rpc = 'add_custom_domain' and key = p_idempotency_key;
      return private.domain_row(d);
    end if;
    -- A claim nobody proved within a week stops blocking the real owner. Same answer for every
    -- other case, so the caller learns nothing about who holds the name.
    if (d.status in ('pending', 'failed') and d.created_at < now() - interval '7 days')
       or (d.status = 'disabled' and d.last_checked_at < now() - interval '30 days') then
      delete from app.custom_domains where id = d.id;
    else
      raise exception 'domain_taken';
    end if;
  end if;

  if (select count(*) from app.custom_domains c where c.org_id = p_org_id) >= 20 then
    raise exception 'invalid_input';
  end if;
  insert into app.custom_domains (org_id, hostname, default_location_id)
  values (p_org_id, h, p_location_id) returning * into d;
  update app.idempotency_keys set response = jsonb_build_object('id', d.id)
  where actor_id = uid and rpc = 'add_custom_domain' and key = p_idempotency_key;
  return private.domain_row(d);
end $$;
comment on function api.add_custom_domain(uuid, text, uuid, uuid) is
  'Owner or admin: registers a hostname for DNS verification (TXT _queue-verify.<host> = verification_token) '
  'and returns it as pending. Hostnames are lower-cased; IPs, non-ASCII, reserved and our own names '
  'raise invalid_input, as does the 20th-plus domain of an org. Adding your own hostname again returns it. '
  'Raises domain_taken when another org holds it (never says who; an unproved claim older than 7 days, or a domain disabled for 30 days, '
  'does not count), not_found for a non-member or foreign location, permission_denied below admin. Idempotent per key.';

create or replace function api.remove_custom_domain(p_domain_id uuid, p_idempotency_key uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  d app.custom_domains;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if p_idempotency_key is null then raise exception 'invalid_input'; end if;
  select * into d from app.custom_domains where id = p_domain_id for update;
  if not found then
    -- A repeat of a removal that already happened is a no-op; anything else is unknown.
    if exists (select 1 from app.idempotency_keys k
               where k.actor_id = uid and k.rpc = 'remove_custom_domain' and k.key = p_idempotency_key) then
      return;
    end if;
    raise exception 'not_found';
  end if;
  perform private.require_key_admin(d.org_id, null);
  insert into app.idempotency_keys (org_id, actor_id, rpc, key)
  values (d.org_id, uid, 'remove_custom_domain', p_idempotency_key)
  on conflict do nothing;
  delete from app.custom_domains where id = d.id;
end $$;
comment on function api.remove_custom_domain(uuid, uuid) is
  'Owner or admin: removes a hostname at once. A repeat with the same idempotency key is a no-op. '
  'Raises not_found for an unknown or foreign id, permission_denied below admin.';

-- Service role only. These two exist for the domain-check Edge Function, which cannot reach the
-- tables with a user session (the public ask endpoint and the daily re-check have none).
create function api.resolve_custom_domain(p_host text) returns text
language sql stable security definer set search_path = '' as $$
  select l.slug
  from app.custom_domains d
  join app.locations l on l.org_id = d.org_id and l.id = d.default_location_id
  join app.organizations o on o.id = d.org_id
  where d.hostname = regexp_replace(lower(btrim(coalesce(p_host, ''))), '(:[0-9]+)?\.?$', '')
    and d.status = 'verified' and o.status = 'active'
$$;
comment on function api.resolve_custom_domain(text) is
  'Service role only: the slug of the location a verified hostname serves, null for anything else '
  '(unknown, pending, failed, disabled, suspended org). Accepts a Host header: port and trailing dot are ignored.';

create function api.record_domain_check(p_domain_id uuid, p_ok boolean) returns api.custom_domain_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  d app.custom_domains;
begin
  select * into d from app.custom_domains where id = p_domain_id for update;
  if not found then raise exception 'not_found'; end if;
  if coalesce(p_ok, false) then
    update app.custom_domains set status = 'verified', failed_checks = 0, last_checked_at = now(),
      verified_at = case when status = 'verified' then verified_at else now() end
    where id = d.id returning * into d;
  else
    update app.custom_domains set failed_checks = failed_checks + 1, last_checked_at = now(),
      status = case when status = 'pending' then 'failed'
                    when status = 'verified' and failed_checks + 1 >= 3 then 'disabled'
                    else status end
    where id = d.id returning * into d;
  end if;
  return private.domain_row(d);
end $$;
comment on function api.record_domain_check(uuid, boolean) is
  'Service role only: records one DNS check. A pass verifies the domain and clears the failure count. '
  'A failure marks a pending domain failed; a verified domain is disabled on its third consecutive failure. '
  'Raises not_found for an unknown id.';

revoke all on function api.resolve_custom_domain(text), api.record_domain_check(uuid, boolean)
  from public, anon, authenticated;
grant execute on function api.resolve_custom_domain(text), api.record_domain_check(uuid, boolean) to service_role;

------------------------------------------------------------------------------------------------
-- Daily re-verification: pg_cron asks the domain-check function (it alone can resolve DNS).
------------------------------------------------------------------------------------------------

create function ops.recheck_custom_domains() returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_url text;
  v_key text;
begin
  if not exists (select 1 from app.custom_domains where status = 'verified') then return; end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'domain_check_url';
  if v_url is null then
    select replace(s.decrypted_secret, 'dispatch-notifications', 'domain-check') into v_url
    from vault.decrypted_secrets s where s.name = 'dispatcher_url';
  end if;
  if v_url is null then return; end if;
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'dispatcher_key';
  perform net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || coalesce(v_key, ''))
  );
exception when others then
  raise warning 'recheck_custom_domains failed: %', sqlerrm;
end $$;
comment on function ops.recheck_custom_domains() is
  'Asks domain-check to re-verify every verified domain (vault secrets domain_check_url, default: '
  'dispatcher_url with the function name swapped, and dispatcher_key). Never raises. Run daily by pg_cron.';
revoke all on function ops.recheck_custom_domains() from public, anon, authenticated;

select cron.schedule('recheck-custom-domains', '20 3 * * *', 'select ops.recheck_custom_domains()');
