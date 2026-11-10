-- PLT13 (#419): operators list the announcements they scheduled. The table's read policy returns
-- only active rows to everyone, operators included, so a scheduled announcement was invisible
-- until it started and couldn't be corrected or cancelled before then.
--
-- A definer function rather than a wider select policy: the policy is what the staff banner
-- reads, so widening it for operators would show them scheduled and ended notices as live
-- banners. The policy keeps its one meaning (active now); this is the operator's view.

create function api.platform_list_announcements()
returns table (
  id uuid,
  severity app.announcement_severity,
  message text,
  starts_at timestamptz,
  ends_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('operator');
  return query
    select a.id, a.severity, a.message, a.starts_at, a.ends_at
    from app.platform_announcements a
    where a.ends_at > now()
    order by a.starts_at, a.id;
end $$;
comment on function api.platform_list_announcements() is
  'Operator only (aal2). Announcements that have not ended, live and scheduled, earliest start '
  'first, for the console to edit or end. Never who wrote them. Raises permission_denied (42501).';

revoke all on function api.platform_list_announcements() from public, anon;
grant execute on function api.platform_list_announcements() to authenticated;
