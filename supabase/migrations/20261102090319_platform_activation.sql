-- #1129: tenant activation funnel and onboarding progress for the operator console.
-- Stages are derived from existing tables; there is no event table. The database owns the stage
-- definitions, the "stuck" threshold and the arithmetic; the console only renders them.
-- Aggregates and staff emails only: no guest names, contacts or answers are read or returned.

create type api.platform_activation as (
  org_id uuid,
  org_status app.org_status,
  -- The furthest stage of the main path reached: business_created ... first_served.
  stage text,
  -- The stage after it on the main path; null once first_served is reached.
  next_stage text,
  -- When `stage` was reached.
  reached_at timestamptz,
  -- Whole days since reached_at; null once first_served is reached (nothing is pending).
  stuck_days int,
  -- True for an active org that has waited at `stage` for private.activation_stuck_days() days or more.
  is_stuck boolean,
  -- Every stage in order: [{stage, reached_at}], reached_at null when not reached.
  stages jsonb
);

create type api.platform_funnel_result as (
  from_date date,
  to_date date,
  -- [{stage, count, conversion_prev, conversion_start}], conversions as 0-1 ratios, null when the base is 0.
  stages jsonb,
  -- Accounts created in the range that have no business and no pending invitation.
  signups_without_business int,
  stuck_total int,
  -- A page of [{org_id, name, owner_email, stage, reached_at, stuck_days}], longest stuck first.
  stuck jsonb
);
grant usage on type api.platform_activation, api.platform_funnel_result to authenticated;

/** How many whole days an active tenant may sit at one stage before it counts as stuck. */
create function private.activation_stuck_days() returns int
language sql immutable set search_path = '' as $$ select 3 $$;

/**
 * Activation of every tenant (or of p_org_ids) created in [p_from, p_to). Main path, in order:
 * signed_up (the founding member's account, or the org if earlier), business_created (the org),
 * location_added, queue_created, line_live (a non-archived queue that is open now), first_guest
 * (first visit), first_served (first visit served). A later stage implies the earlier ones: if
 * a visit exists the line was live, whatever the queue says today, and a stage's time is never
 * later than the next stage's. Two side milestones are independent of the path:
 * staff_invite_accepted and card_on_file (a Stripe subscription that got past incomplete).
 */
create function private.org_activation(p_org_ids uuid[], p_from timestamptz, p_to timestamptz)
returns setof api.platform_activation
language sql stable set search_path = '' as $$
  with raw as (
    select o.id, o.status, o.created_at as business,
           (select u.created_at from app.memberships m join auth.users u on u.id = m.user_id
            where m.org_id = o.id order by m.created_at, m.user_id limit 1) as founder,
           (select min(l.created_at) from app.locations l where l.org_id = o.id) as loc,
           (select min(q.created_at) from app.queues q where q.org_id = o.id) as queue,
           (select min(q.created_at) from app.queues q
            where q.org_id = o.id and q.archived_at is null and q.manual_state = 'open') as live,
           (select min(v.joined_at) from app.visits v where v.org_id = o.id) as guest,
           (select min(coalesce(v.finished_at, v.joined_at)) from app.visits v
            where v.org_id = o.id and v.status = 'served') as served,
           (select min(i.accepted_at) from app.invitations i where i.org_id = o.id) as invite,
           (select coalesce(s.last_event_at, s.updated_at) from app.subscriptions s
            where s.org_id = o.id and s.stripe_subscription_id is not null
              and s.status not in ('incomplete', 'incomplete_expired')) as card
    from app.organizations o
    where (p_org_ids is null or o.id = any (p_org_ids))
      and (p_from is null or o.created_at >= p_from)
      and (p_to is null or o.created_at < p_to)
  ), c as (
    -- Suffix minimum: each stage is at most as late as every stage after it.
    select r.*,
           r.served as c7,
           least(r.guest, r.served) as c6,
           least(r.live, r.guest, r.served) as c5,
           least(r.queue, r.live, r.guest, r.served) as c4,
           least(r.loc, r.queue, r.live, r.guest, r.served) as c3,
           least(r.business, r.loc, r.queue, r.live, r.guest, r.served) as c2,
           least(r.founder, r.business, r.loc, r.queue, r.live, r.guest, r.served) as c1
    from raw r
  ), d as (
    select c.*,
           case when c7 is not null then 'first_served' when c6 is not null then 'first_guest'
                when c5 is not null then 'line_live' when c4 is not null then 'queue_created'
                when c3 is not null then 'location_added' else 'business_created' end as cur,
           coalesce(c7, c6, c5, c4, c3, c2) as cur_at
    from c
  )
  select d.id, d.status, d.cur,
         case d.cur when 'business_created' then 'location_added' when 'location_added' then 'queue_created'
                    when 'queue_created' then 'line_live' when 'line_live' then 'first_guest'
                    when 'first_guest' then 'first_served' end,
         d.cur_at,
         case when d.c7 is null then greatest(0, floor(extract(epoch from now() - d.cur_at) / 86400))::int end,
         d.c7 is null and d.status = 'active'
           and floor(extract(epoch from now() - d.cur_at) / 86400) >= private.activation_stuck_days(),
         jsonb_build_array(
           jsonb_build_object('stage', 'signed_up', 'reached_at', d.c1),
           jsonb_build_object('stage', 'business_created', 'reached_at', d.c2),
           jsonb_build_object('stage', 'location_added', 'reached_at', d.c3),
           jsonb_build_object('stage', 'queue_created', 'reached_at', d.c4),
           jsonb_build_object('stage', 'line_live', 'reached_at', d.c5),
           jsonb_build_object('stage', 'first_guest', 'reached_at', d.c6),
           jsonb_build_object('stage', 'first_served', 'reached_at', d.c7),
           jsonb_build_object('stage', 'staff_invite_accepted', 'reached_at', d.invite),
           jsonb_build_object('stage', 'card_on_file', 'reached_at', d.card))
  from d
$$;

create function api.platform_org_activation(p_org_ids uuid[]) returns setof api.platform_activation
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('support');
  if p_org_ids is null or cardinality(p_org_ids) not between 1 and 200 then
    raise exception 'invalid_input';
  end if;
  return query select * from private.org_activation(p_org_ids, null, null) a order by a.org_id;
end $$;
comment on function api.platform_org_activation(uuid[]) is
  'Support or operator with aal2: how far each listed tenant has got, derived from its own rows. '
  'Returns the furthest stage of the main path (business_created, location_added, queue_created, '
  'line_live, first_guest, first_served), the next stage, when it was reached, whole days stuck '
  'there (null once first_served), is_stuck (active org, 3 days or more) and every stage with '
  'its time, including the side milestones staff_invite_accepted and card_on_file. Unknown ids '
  'are left out; a tenant with nothing but its business row is at business_created. Counts and '
  'times only, no guest data. Raises permission_denied (42501) without a platform role and aal2, '
  'invalid_input for null, empty or more than 200 ids.';

create function api.platform_funnel(
  p_from date default null,
  p_to date default null,
  p_stage text default null,
  p_limit int default 50,
  p_offset int default 0
) returns api.platform_funnel_result
language plpgsql stable security definer set search_path = '' as $$
declare
  v_to date := coalesce(p_to, (now() at time zone 'UTC')::date);
  v_from date := coalesce(p_from, coalesce(p_to, (now() at time zone 'UTC')::date) - 29);
  v_lo timestamptz;
  v_hi timestamptz;
  result api.platform_funnel_result;
begin
  perform private.require_platform('support');
  if v_from > v_to or p_limit is null or p_limit not between 1 and 200
     or p_offset is null or p_offset < 0
     or (p_stage is not null and p_stage not in
         ('business_created', 'location_added', 'queue_created', 'line_live', 'first_guest')) then
    raise exception 'invalid_input';
  end if;
  -- Calendar days in UTC, both ends inclusive, whatever the session time zone.
  v_lo := v_from::timestamp at time zone 'UTC';
  v_hi := (v_to + 1)::timestamp at time zone 'UTC';

  result.from_date := v_from;
  result.to_date := v_to;
  with orphans as (
    select count(*)::int as n from auth.users u
    where u.email is not null and u.created_at >= v_lo and u.created_at < v_hi
      and not exists (select 1 from app.memberships m where m.user_id = u.id)
      and not exists (select 1 from app.platform_roles r where r.user_id = u.id)
      and not exists (select 1 from app.invitations i
                      where i.email = lower(u.email) and i.revoked_at is null)
  ), act as materialized (
    select * from private.org_activation(null, v_lo, v_hi)
  ), names(ord, stage) as (
    values (1, 'signed_up'), (2, 'business_created'), (3, 'location_added'), (4, 'queue_created'),
           (5, 'line_live'), (6, 'first_guest'), (7, 'first_served'),
           (8, 'staff_invite_accepted'), (9, 'card_on_file')
  ), n as (
    select ord, stage,
           (select count(*) from act a, jsonb_array_elements(a.stages) s
            where s ->> 'stage' = names.stage and s ->> 'reached_at' is not null)
           + case when stage = 'signed_up' then (select n from orphans) else 0 end as cnt
    from names
  ), p as (
    select *, lag(cnt) over (order by ord) as prev, first_value(cnt) over (order by ord) as start from n
  ), stuck as (
    select a.org_id, o.name, a.stage, a.reached_at, a.stuck_days,
           (select u.email from app.memberships m join auth.users u on u.id = m.user_id
            where m.org_id = o.id and m.role = 'owner' order by m.created_at, m.user_id limit 1) as owner_email
    from act a join app.organizations o on o.id = a.org_id
    where a.is_stuck and (p_stage is null or a.stage = p_stage)
  )
  select (select n from orphans),
         -- Side milestones are measured against the tenants that signed up, not the previous row.
         (select jsonb_agg(jsonb_build_object(
                   'stage', stage, 'count', cnt,
                   'conversion_prev', case when ord = 1 then null
                                           when ord >= 8 then round(cnt::numeric / nullif(start, 0), 4)
                                           else round(cnt::numeric / nullif(prev, 0), 4) end,
                   'conversion_start', round(cnt::numeric / nullif(start, 0), 4)) order by ord) from p),
         (select count(*)::int from stuck),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'org_id', x.org_id, 'name', x.name, 'owner_email', x.owner_email, 'stage', x.stage,
                     'reached_at', x.reached_at, 'stuck_days', x.stuck_days)
                   order by x.reached_at, x.org_id)
                   from (select * from stuck order by reached_at, org_id
                         limit p_limit offset p_offset) x), '[]')
  into result.signups_without_business, result.stages, result.stuck_total, result.stuck;
  return result;
end $$;
comment on function api.platform_funnel(date, date, text, int, int) is
  'Support or operator with aal2: the activation funnel for tenants created between p_from and '
  'p_to, both inclusive, as UTC calendar days (default: the last 30 days). Returns, for each '
  'stage in order (signed_up, business_created, location_added, queue_created, line_live, '
  'first_guest, first_served, then staff_invite_accepted and card_on_file), how many tenants '
  'reached it and the conversion from the previous stage (side milestones: from signed_up) and '
  'from the start; signed_up also counts accounts that never created a business. Also returns '
  'the active tenants stuck for 3 days or more before first_served, longest stuck first, '
  'optionally for one stage (business_created, location_added, queue_created, line_live or '
  'first_guest), a page at a time with p_limit 1-200 and p_offset. Suspended and pending-deletion '
  'tenants count in the stages but are never listed as stuck. Counts and times only, no guest '
  'data. Raises permission_denied (42501) without a platform role and aal2, invalid_input for '
  'p_from after p_to, an unknown stage, p_limit outside 1-200 or a negative p_offset.';

revoke all on function private.activation_stuck_days() from public, anon, authenticated;
revoke all on function private.org_activation(uuid[], timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function api.platform_org_activation(uuid[]) from public, anon;
revoke all on function api.platform_funnel(date, date, text, int, int) from public, anon;
grant execute on function api.platform_org_activation(uuid[]) to authenticated;
grant execute on function api.platform_funnel(date, date, text, int, int) to authenticated;

notify pgrst, 'reload schema';
