-- DS-14 (#1018): api.org_setup_state, the single source of truth for the first-run checklist.
-- New entry point (interface rule 1): the checklist needs five facts across five tables, some
-- hidden from managers by RLS (invitations); composing them in the client would re-derive
-- "set up" in TypeScript and cost four round trips on the busiest admin page.

create type api.org_setup_state as (
  location_id uuid,
  has_hours boolean,        -- weekly opening hours saved for the location
  has_queue boolean,        -- at least one active (unarchived) queue at the location
  has_visit boolean,        -- anyone has ever joined a queue at the location
  members integer,          -- people with a membership in the org
  pending_invitations integer, -- invitations neither accepted, revoked nor expired
  devices integer,          -- paired, non-revoked displays and kiosks at the location
  as_of timestamptz
);

create function api.org_setup_state(p_org_id uuid, p_location_id uuid) returns api.org_setup_state
language plpgsql stable security definer set search_path = '' as $$
declare
  result api.org_setup_state;
begin
  -- Same answer for a foreign org, a foreign location and a missing role: no existence leak.
  if not exists (select 1 from app.locations l where l.id = p_location_id and l.org_id = p_org_id)
     or not private.has_role(p_org_id, p_location_id, 'manager') then
    raise exception 'not_found';
  end if;

  result.location_id := p_location_id;
  result.has_hours := exists (select 1 from app.business_hours h where h.location_id = p_location_id);
  result.has_queue := exists (
    select 1 from app.queues q where q.location_id = p_location_id and q.archived_at is null);
  result.has_visit := exists (select 1 from app.visits v where v.location_id = p_location_id);
  result.members := (select count(*)::integer from app.memberships m where m.org_id = p_org_id);
  result.pending_invitations := (
    select count(*)::integer from app.invitations i
    where i.org_id = p_org_id and i.accepted_at is null and i.revoked_at is null
      and i.expires_at > now());
  result.devices := (
    select count(*)::integer from app.devices d
    where d.location_id = p_location_id and d.revoked_at is null);
  result.as_of := now();
  return result;
end $$;
comment on function api.org_setup_state(uuid, uuid) is
  'First-run checklist facts for one location: whether weekly hours are saved, an active queue '
  'exists, anyone has ever joined, and the counts of org members, pending invitations (not '
  'accepted, revoked or expired) and paired non-revoked devices. Callable by managers and above '
  'of the location; raises not_found for anyone else, for a location outside the org, and for '
  'display and kiosk devices. Read-only.';
revoke all on function api.org_setup_state(uuid, uuid) from public, anon;
grant execute on function api.org_setup_state(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
