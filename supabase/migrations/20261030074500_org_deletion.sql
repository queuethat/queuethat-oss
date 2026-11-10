-- 2P-PRV7 (#194): org deletion request, lockout and database purge (X-5).
--
-- An owner requests deletion with the typed join slug; the org goes to pending_deletion at once:
-- every role check fails, queues are closed (the accepting predicate treats it as not active),
-- devices stop (is_device) and guest slug lookups say not_found. For 7 days the owner can cancel.
-- Then ops.purge_deleted_orgs() removes every row of the org. It is the only hard delete of visits,
-- runs as the database owner from pg_cron and switches the append-only and audit triggers off for
-- the tables it empties; no API role can reach it.

alter table app.organizations
  add column deletion_requested_at timestamptz,
  add column deletion_scheduled_for timestamptz;

create table ops.org_deletion_log (
  org_id uuid primary key,
  requested_at timestamptz not null,
  purged_at timestamptz not null default now()
);

create function private.org_pending_deletion(p_org_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.organizations o where o.id = p_org_id and o.status = 'pending_deletion')
$$;
revoke all on function private.org_pending_deletion(uuid) from public, anon, authenticated;

-- redefines private.has_role from 20261030071042_operator_switch.sql
create or replace function private.has_role(p_org_id uuid, p_location_id uuid, p_min_role app.member_role)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare os app.operator_sessions := private.operator_session();
begin
  -- An operator's authority is their own, and only at the session's location.
  if os.id is not null and (os.org_id <> p_org_id or (p_location_id is not null and p_location_id <> os.location_id)) then
    return false;
  end if;
  return exists (
    select 1
    from app.memberships m
    join app.organizations o on o.id = m.org_id
    where m.user_id = coalesce(os.operator_user_id, (select auth.uid()))
      and m.org_id = p_org_id
      and (case
             -- A PIN is not a second factor: an operator never exceeds manager, whatever the tablet's session.
             when m.role > 'manager' and os.id is not null then 'manager'::app.member_role
             when o.require_mfa_for_admins and m.role > 'manager'
                  and coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2' then 'manager'::app.member_role
             else m.role
           end) >= p_min_role
      and (m.location_ids is null or p_location_id is null or p_location_id = any (m.location_ids))
      and (o.status = 'active' or (p_min_role = 'staff' and o.status <> 'pending_deletion'))
  ) or (os.id is null and exists (
    select 1
    from private.support_grant(p_org_id) g
    join app.organizations o on o.id = g.org_id
    where g.id is not null
      and case g.scope when 'act' then p_min_role <= 'admin' else p_min_role = 'staff' end
      and (o.status = 'active' or (p_min_role = 'staff' and o.status <> 'pending_deletion'))
  ));
end $$;
comment on function private.has_role(uuid, uuid, app.member_role) is
  'True when the caller is a member of the org with at least p_min_role. With a location, the '
  'membership must cover it (location_ids null = all). With p_location_id null, any membership '
  'in the org counts. A platform user with a live support grant (private.support_grant) passes '
  'staff-level checks with ''read'' and checks up to admin with ''act'', at every location; '
  'never owner. When the org is suspended, only staff-level checks pass; every manager-level or higher check '
  'fails. When it is pending_deletion, every check fails (the owner cancels through '
  'api.cancel_org_deletion, which checks membership directly). When the org requires MFA '
  '(require_mfa_for_admins), an owner or admin whose session is not aal2 counts as a manager. '
  'While an operator token is present the operator''s membership is checked instead of the '
  'caller''s, capped at manager, for that session''s location only; an invalid token raises operator_session_invalid. '
  'Staff-level checks also admit reads, so writes behind them are refused by '
  'private.write_blocked_reason. The only role check policies and api functions use.';

-- redefines api.get_location_public from 20261029205946_join_pass.sql
create or replace function api.get_location_public(p_location_slug text) returns api.location_public
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
  result api.location_public;
begin
  select * into l from app.locations where slug = p_location_slug;
  if not found then
    select loc.* into l
    from app.slug_redirects r join app.locations loc on loc.id = r.location_id
    where r.old_slug = p_location_slug;
  end if;
  if l.id is null or private.org_pending_deletion(l.org_id) then
    raise exception 'not_found';
  end if;

  select l.id, l.name, l.slug, l.tz, l.address, l.contact,
         coalesce(array_agg(row(
           q.id, q.name, q.manual_state, r.reason is null, r.reason,
           (select count(*)::int from app.visits v where v.queue_id = q.id and v.status = 'waiting'),
           e.eta_state, e.eta_low, e.eta_high, q.pulse_id,
           array(select row(s.id, s.name, s.description)::api.public_service
                 from app.services s
                 where s.queue_id = q.id and s.active
                 order by s.sort_order, s.name)
         )::api.public_queue order by q.sort_order, q.name) filter (where q.id is not null),
         '{}'),
         l.country_code,
         (select s.turnstile_site_key from private.deployment_settings s)
  into result
  from (select 1) one
  left join app.queues q on q.location_id = l.id and q.archived_at is null
  -- This page is the online entry point, so the hourly online ceiling counts as not accepting.
  left join lateral (
    select coalesce(private.queue_not_accepting_reason(q.id),
                    case when app.online_joins_paused_until(q) is not null then 'online_full' end) as reason
  ) r on true
  left join lateral private.queue_eta(q.id) e on true;
  return result;
end $$;
comment on function api.get_location_public(text) is
  'Public view of a location by its slug (or a redirected old slug; slug is always the current '
  'one): name, contact, country (null when not set), and each non-archived queue with its '
  'accepting state and reason, waiting count, ETA for someone joining now, pulse topic and '
  'active services. Reasons are those of queue_not_accepting_reason, then ''online_full'' when '
  'the queue reached its hourly online-join ceiling (join_queue would refuse it with '
  'rate_limited, DETAIL queue_total); staff can still add guests then. captcha_site_key is the '
  'Turnstile site key when online joins need a pass (api.issue_join_pass), else null. Contains '
  'no guest data. Raises not_found for an unknown slug.';

-- redefines api.get_location_wait from 20261030061435_location_wait.sql
create or replace function api.get_location_wait(p_location_slug text) returns setof api.public_wait
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
begin
  select * into l from app.locations where slug = p_location_slug;
  if not found then
    select loc.* into l
    from app.slug_redirects r join app.locations loc on loc.id = r.location_id
    where r.old_slug = p_location_slug;
  end if;
  if l.id is null or private.org_pending_deletion(l.org_id) then
    raise exception 'not_found';
  end if;

  return query
  select q.id, q.name,
         r.reason is null,
         (select count(*)::int from app.visits v where v.queue_id = q.id and v.status = 'waiting'),
         e.eta_low, e.eta_high, e.eta_state,
         case when private.location_open_at(l.id, now()) then null
              else private.location_next_change(l.id, now()) end,
         now()
  from app.queues q
  -- Same rule as get_location_public: this is the online entry point, so the hourly ceiling counts.
  cross join lateral (
    select coalesce(private.queue_not_accepting_reason(q.id),
                    case when app.online_joins_paused_until(q) is not null then 'online_full' end) as reason
  ) r
  cross join lateral private.queue_eta(q.id) e
  where q.location_id = l.id and q.archived_at is null
  order by q.sort_order, q.name;
end $$;
comment on function api.get_location_wait(text) is
  'One row per non-archived queue of the location (or its redirected old slug): accepting (the '
  'queue accepting predicate, plus the hourly online ceiling as get_location_public), waiting '
  'count, the ETA a guest joining now would get (private.queue_eta: eta_state hidden, paused, '
  'unstaffed, next, over_hour, uncertain or ok, with numbers only for the last three), opens_next_at '
  '(the next opening while the location is closed by its hours, else null) and the server time. Contains no guest data. Raises not_found for an '
  'unknown slug.';

create function api.request_org_deletion(p_org_id uuid, p_confirm_slug text) returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare
  o app.organizations;
  v_slug text;
begin
  select * into o from app.organizations where id = p_org_id for update;
  if not found or not exists (
       select 1 from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = o.id and m.role = 'owner') then
    raise exception 'not_found';
  end if;
  if o.status = 'pending_deletion' then
    return o.deletion_scheduled_for; -- repeating is a no-op
  end if;
  if not private.has_role(o.id, null, 'owner') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  perform private.require_aal2_if_enrolled();
  select l.slug into v_slug from app.locations l where l.org_id = o.id order by l.created_at, l.id limit 1;
  if p_confirm_slug is distinct from v_slug then
    raise exception 'invalid_input';
  end if;
  update app.organizations
  set status = 'pending_deletion', deletion_requested_at = now(),
      deletion_scheduled_for = now() + interval '7 days'
  where id = o.id
  returning deletion_scheduled_for into o.deletion_scheduled_for;
  return o.deletion_scheduled_for;
end $$;
comment on function api.request_org_deletion(uuid, text) is
  'Starts deletion of the org; owner only (aal2 when the owner has an authenticator). p_confirm_slug '
  'must equal the org''s first location''s join slug. From that moment every role check fails, queues '
  'are closed, devices stop and guest lookups say not_found. Returns the purge time (7 days out); '
  'repeating returns the same time. Raises not_found for an org the caller does not own, '
  'invalid_input for a wrong slug, permission_denied for a suspended org. Implemented in 2P-PRV7 (#194).';

create function api.cancel_org_deletion(p_org_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not exists (
       select 1 from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = p_org_id and m.role = 'owner') then
    raise exception 'not_found';
  end if;
  if private.operator_session() is not null and (private.operator_session()).id is not null then
    raise exception 'permission_denied' using errcode = '42501'; -- a PIN operator never cancels
  end if;
  perform private.require_aal2_if_enrolled();
  update app.organizations
  set status = 'active', deletion_requested_at = null, deletion_scheduled_for = null
  where id = p_org_id and status = 'pending_deletion' and deletion_scheduled_for > now();
end $$;
comment on function api.cancel_org_deletion(uuid) is
  'Cancels a pending deletion before the purge time and restores access; owner only. Does nothing '
  'for an org that is not pending. Raises not_found for an org the caller does not own. '
  'Implemented in 2P-PRV7 (#194).';

revoke all on function api.request_org_deletion(uuid, text), api.cancel_org_deletion(uuid) from public, anon;
grant execute on function api.request_org_deletion(uuid, text), api.cancel_org_deletion(uuid) to authenticated;

/**
 * Deletes every row of orgs whose grace period ended, and the org, then logs it without names.
 * The only hard delete of visits. Needs the database owner (it switches the append-only and audit
 * triggers off for the tables it empties, inside its own transaction); not callable via the API.
 * Holds locks on every tenant table until it commits (that is what keeps other writers out of
 * the trigger-free window), so it runs once a day at a quiet hour. A failing org is skipped with a
 * warning and retried the next day. Not purged: private.* logs (they expire on their own), auth
 * users (api: purge-org, #195). Returns orgs purged.
 */
create function ops.purge_deleted_orgs() returns int
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
  select coalesce(array_agg(id), '{}') into v_due from app.organizations
  where status = 'pending_deletion' and deletion_scheduled_for <= now();
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

select cron.schedule('purge-deleted-orgs', '47 3 * * *', 'select ops.purge_deleted_orgs()');
