-- 2P-RPT4 (#200): api.begin_data_export. Owners and org-wide admins start a full export of their
-- organization; the Edge Function export-data then streams the files as the caller, so RLS still applies.
-- The ticket is a row of its own: the function checks it, and the three-per-day limit counts these rows.

create table app.data_exports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  actor uuid not null,
  format text not null check (format in ('csv', 'jsonl')),
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (org_id, idempotency_key)
);
create index data_exports_org_created_idx on app.data_exports (org_id, created_at);

alter table app.data_exports enable row level security;
-- Only the person who started an export reads its ticket; rows are written by begin_data_export alone.
create policy data_exports_select on app.data_exports for select to authenticated
  using (actor = (select auth.uid()) and private.has_role(org_id, null, 'admin'));
revoke all on app.data_exports from public, anon, authenticated;
grant select on app.data_exports to authenticated;

create type api.export_ticket as (export_id uuid, format text, remaining_today int, expires_at timestamptz);

create function api.begin_data_export(p_format text, p_idempotency_key uuid)
returns api.export_ticket
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  m record;
  t app.data_exports;
  used int;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_format is null or p_format not in ('csv', 'jsonl') or p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;

  -- Raw membership, not has_role: an owner below aal2 must be told to step up, not be denied.
  -- Org-wide only: a location-scoped admin must not export the other locations.
  select mem.org_id, mem.role, o.require_mfa_for_admins as mfa into m
  from app.memberships mem
  join app.organizations o on o.id = mem.org_id
  where mem.user_id = uid and mem.role >= 'admin' and mem.location_ids is null and o.status = 'active'
  order by mem.role desc, mem.created_at
  limit 1;
  if not found then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  perform private.require_aal2_if_enrolled();
  if m.mfa and coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2' then
    raise exception 'mfa_required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('data_export:' || m.org_id::text, 0));
  select * into t from app.data_exports where org_id = m.org_id and idempotency_key = p_idempotency_key;
  if not found then
    select count(*)::int into used from app.data_exports
    where org_id = m.org_id and created_at > now() - interval '24 hours';
    if used >= 3 then
      raise exception 'rate_limited';
    end if;
    insert into app.data_exports (org_id, actor, format, idempotency_key, expires_at)
    values (m.org_id, uid, p_format, p_idempotency_key, now() + interval '15 minutes')
    returning * into t;
    insert into app.audit_log (org_id, actor, role, action, table_name, row_id, after)
    values (m.org_id, uid, m.role::text, 'EXPORT', 'data_exports', t.id::text,
            jsonb_build_object('kind', 'data_export', 'format', p_format));
  end if;

  select count(*)::int into used from app.data_exports
  where org_id = m.org_id and created_at > now() - interval '24 hours';
  return (t.id, t.format, greatest(0, 3 - used), t.expires_at)::api.export_ticket;
end $$;
comment on function api.begin_data_export(text, uuid) is
  'Starts a full export of the caller''s organization (p_format csv or jsonl) and returns a ticket '
  'valid for 15 minutes for the export-data Edge Function. Owners and org-wide admins only; at most '
  '3 new exports per rolling 24 hours per org; every new export is written to audit_log as an EXPORT of data_exports. '
  'Repeating a key returns the same ticket. Raises not_authenticated, invalid_input, permission_denied, '
  'mfa_required, rate_limited.';
revoke all on function api.begin_data_export(text, uuid) from public, anon;
grant execute on function api.begin_data_export(text, uuid) to authenticated;
