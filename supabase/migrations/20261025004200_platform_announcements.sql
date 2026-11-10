-- PLT9 (#415): platform announcements. Operators warn every shop before maintenance or during an
-- incident; staff see active announcements as a banner in the console and admin.
--
--   * Readable by every signed-in user, and only while active (starts_at <= now() < ends_at).
--     The read policy is the one place "active" is decided; clients render what they get.
--   * Written only through api.platform_upsert_announcement (operator, aal2). Every write is
--     audited by trigger, so a service-role write (e2e, ops) lands in platform_audit too.
--   * Not tenant data: no org_id, no PII. anon has no access, so guest routes never see one.

------------------------------------------------------------------------------------------------
-- Table
------------------------------------------------------------------------------------------------

-- Declaration order is the display order, most severe last: clients sort descending.
create type app.announcement_severity as enum ('info', 'warning', 'maintenance');
grant usage on type app.announcement_severity to authenticated, service_role;

create table app.platform_announcements (
  id uuid primary key default gen_random_uuid(),
  severity app.announcement_severity not null,
  message text not null check (length(trim(message)) between 1 and 500),
  starts_at timestamptz not null default now(),
  -- Required, so a forgotten announcement can't stay up forever. Ending early = set it to now().
  ends_at timestamptz not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index platform_announcements_ends_at_idx on app.platform_announcements (ends_at);

create function private.audit_platform_announcement() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r app.platform_announcements := coalesce(new, old);
begin
  perform private.platform_audit(
    case tg_op when 'INSERT' then 'announcement.create'
               when 'UPDATE' then 'announcement.update'
               else 'announcement.delete' end,
    null,
    jsonb_build_object(
      'id', r.id, 'severity', r.severity, 'message', r.message,
      'starts_at', r.starts_at, 'ends_at', r.ends_at,
      'via', coalesce((select auth.jwt()) ->> 'role', session_user)
    ),
    null);
  return null;
end $$;
comment on function private.audit_platform_announcement() is
  'AFTER trigger on platform_announcements: every create, update and delete lands in '
  'platform_audit, whichever role made it.';

create trigger audit_platform_announcement after insert or update or delete on app.platform_announcements
  for each row execute function private.audit_platform_announcement();

------------------------------------------------------------------------------------------------
-- api.platform_upsert_announcement
------------------------------------------------------------------------------------------------

create function api.platform_upsert_announcement(
  p_severity app.announcement_severity,
  p_message text,
  p_ends_at timestamptz,
  p_starts_at timestamptz default null,
  p_id uuid default null
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  starts timestamptz := coalesce(p_starts_at, now());
  result uuid;
begin
  perform private.require_platform('operator');
  if p_severity is null or p_ends_at is null or p_ends_at <= starts
     or length(trim(coalesce(p_message, ''))) not between 1 and 500 then
    raise exception 'invalid_input';
  end if;

  if p_id is null then
    insert into app.platform_announcements (severity, message, starts_at, ends_at, created_by)
    values (p_severity, trim(p_message), starts, p_ends_at, (select auth.uid()))
    returning id into result;
  else
    update app.platform_announcements
       set severity = p_severity, message = trim(p_message), starts_at = starts, ends_at = p_ends_at
     where id = p_id
    returning id into result;
    if result is null then
      raise exception 'not_found';
    end if;
  end if;
  return result;
end $$;
comment on function api.platform_upsert_announcement(app.announcement_severity, text, timestamptz, timestamptz, uuid) is
  'Operator only (aal2). Creates an announcement shown to every signed-in user from p_starts_at '
  '(default now) until p_ends_at, or replaces announcement p_id. End one early by setting '
  'p_ends_at to now(). Audited. Returns the id. Raises permission_denied (42501), invalid_input '
  '(blank or over 500 characters, ends_at not after starts_at), not_found (unknown p_id).';

revoke all on function api.platform_upsert_announcement(app.announcement_severity, text, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function api.platform_upsert_announcement(app.announcement_severity, text, timestamptz, timestamptz, uuid) to authenticated;

------------------------------------------------------------------------------------------------
-- Privileges and row-level security
------------------------------------------------------------------------------------------------

-- API users write only through the RPC and read only what the banner shows (not who wrote it).
-- The service role keeps writes for ops and e2e fixtures; the trigger audits them.
revoke all on app.platform_announcements from authenticated;
grant select (id, severity, message, starts_at, ends_at) on app.platform_announcements to authenticated;

alter table app.platform_announcements enable row level security;

create policy platform_announcements_select on app.platform_announcements for select to authenticated
  using (starts_at <= now() and ends_at > now());
