-- #1132: the "needs attention" queue for the platform console. One function tells an operator which
-- tenants need a human today, from rules the database owns; the console only renders and links.
-- Inputs reuse #1129 (private.org_activation), #1130 (notification outcomes), #1131 (subscriptions),
-- #1138 (support requests), #1135 (note tags) and #1155 (SMS auto-pause).
-- Interface choice: (a) one api.platform_attention(limit) over a private rule set, (b) a widget per source
-- that merges client-side. (a) won: thresholds live in one SQL function, ranking is the database's,
-- and an ack can hide one item whatever source it came from.
-- Not built (optional in the ticket): the daily digest email. It needs a platform-level recipient
-- list and template, which is a product call; this queue is the source it would read.

create table app.platform_attention_acks (
  org_id uuid not null references app.organizations (id) on delete cascade,
  reason text not null,
  acked_by uuid,
  acked_at timestamptz not null default now(),
  snooze_until timestamptz not null,
  primary key (org_id, reason)
);
alter table app.platform_attention_acks enable row level security;
revoke all on app.platform_attention_acks from public, anon, authenticated, service_role;
grant select on app.platform_attention_acks to authenticated;
create policy platform_attention_acks_select on app.platform_attention_acks for select to authenticated
  using ((select private.is_platform('operator')));
comment on table app.platform_attention_acks is
  'Who snoozed which attention item until when. Written only by api.platform_ack_attention.';

/** Priority of a reason, lower first; null for a reason that does not exist. The one list of reasons. */
create function private.attention_priority(p_reason text) returns int
language sql immutable set search_path = '' as $$
  select case p_reason
    when 'support_request_open' then 1
    when 'payment_past_due' then 2
    when 'sms_auto_paused' then 3
    when 'pending_deletion' then 4
    when 'tagged_attention' then 5
    when 'message_failures' then 6
    when 'device_offline' then 7
    when 'plan_limit' then 8
    when 'login_lockout' then 9
    when 'stuck_onboarding' then 10
    when 'no_recent_visits' then 11
  end
$$;
revoke all on function private.attention_priority(text) from public, anon, authenticated;

/**
 * Every rule, one query each. `since` is when the condition began, `detail` the numbers behind it.
 *  support_request_open  an open support request (since: the oldest open one)
 *  payment_past_due      subscription past_due or unpaid while billing is on (since: its last Stripe event)
 *  sms_auto_paused       platform SMS paused by the abuse job; an operator's own pause is not news
 *  pending_deletion      owner asked to delete the business; the purge date is in detail
 *  tagged_attention      a teammate's current note carries a tag from private.note_attention_tags (#1135);
 *                        since: that note's time. This replaces the Directory's own attention list.
 *  message_failures      24 h: at least 20 attempted and 25% or more failed/dead (suppressed does not count)
 *  device_offline        a display/kiosk unseen for 30 min to 7 days while its location is open now
 *  plan_limit            staff seats used up (a free business at 3/3 wants an upgrade) or more locations than allowed
 *  login_lockout         a member is locked out of MFA right now (5 wrong codes in 15 min; the log keeps no longer)
 *  stuck_onboarding      active org stuck at one activation stage for the funnel's threshold, up to 30 days
 *                        (older is abandoned, not "today")
 *  no_recent_visits      active org with a live line, no visit for 7 to 30 days
 */
create function private.platform_attention_raw()
returns table (org_id uuid, reason text, since timestamptz, detail jsonb)
language sql stable set search_path = '' as $$
  select r.org_id, 'support_request_open', min(r.created_at), jsonb_build_object('count', count(*))
  from app.support_requests r where r.status = 'open' group by r.org_id
  union all
  select s.org_id, 'payment_past_due', coalesce(s.last_event_at, s.updated_at),
         jsonb_build_object('status', s.status, 'grace_ends_at', s.grace_ends_at)
  from app.subscriptions s where private.billing_enabled() and s.status in ('past_due', 'unpaid')
  union all
  select p.org_id, 'sms_auto_paused', p.set_at, jsonb_build_object('why', p.reason)
  from private.platform_sms_pauses p where p.state = 'auto'
  union all
  select o.id, 'pending_deletion', coalesce(o.deletion_requested_at, o.created_at),
         jsonb_build_object('scheduled_for', o.deletion_scheduled_for)
  from app.organizations o where o.status = 'pending_deletion'
  union all
  select c.org_id, 'tagged_attention', max(c.created_at), jsonb_build_object('tags', array_agg(distinct t order by t))
  from app.platform_org_notes c, unnest(c.tags) t
  where c.version = (select max(x.version) from app.platform_org_notes x where x.root_id = c.root_id)
    and t = any (private.note_attention_tags())
  group by c.org_id
  union all
  select n.org_id, 'message_failures', min(n.created_at) filter (where n.status::text in ('failed', 'dead')),
         jsonb_build_object('failed', count(*) filter (where n.status::text in ('failed', 'dead')), 'attempted', count(*))
  from app.notifications n
  where n.created_at > now() - interval '24 hours' and n.status::text in ('sent', 'delivered', 'failed', 'dead')
  group by n.org_id
  having count(*) >= 20 and count(*) filter (where n.status::text in ('failed', 'dead')) * 4 >= count(*)
  union all
  select d.org_id, 'device_offline', min(d.last_seen_at), jsonb_build_object('count', count(*))
  from app.devices d join app.organizations o on o.id = d.org_id and o.status = 'active'
  where d.revoked_at is null and d.last_seen_at < now() - interval '30 minutes'
    and d.last_seen_at > now() - interval '7 days' and private.location_open_at(d.location_id, now())
  group by d.org_id
  union all
  select u.id, 'plan_limit', u.since,
         jsonb_build_object('members', u.members, 'member_limit', u.member_limit,
                            'locations', u.locations, 'location_limit', u.location_limit)
  from (select o.id,
               (select count(*)::int from app.memberships m where m.org_id = o.id) as members,
               nullif(private.entitlement(o.id, 'limit.members') #>> '{}', '')::int as member_limit,
               (select count(*)::int from app.locations l where l.org_id = o.id) as locations,
               nullif(private.entitlement(o.id, 'limit.locations') #>> '{}', '')::int as location_limit,
               greatest((select max(m.created_at) from app.memberships m where m.org_id = o.id),
                        (select max(l.created_at) from app.locations l where l.org_id = o.id)) as since
        from app.organizations o where o.status = 'active') u
  where (u.member_limit >= 0 and u.members >= u.member_limit)
     or (u.location_limit >= 0 and u.locations > u.location_limit)
  union all
  select m.org_id, 'login_lockout', min(f.first_at), jsonb_build_object('count', count(distinct f.user_id))
  from (select x.user_id, min(x.at) as first_at from private.mfa_failures x
        group by x.user_id having count(*) >= 5) f
  join app.memberships m on m.user_id = f.user_id
  group by m.org_id
  union all
  select a.org_id, 'stuck_onboarding', a.reached_at, jsonb_build_object('stage', a.stage, 'days', a.stuck_days)
  from private.org_activation(null, null, null) a where a.is_stuck and a.stuck_days <= 30
  union all
  select v.id, 'no_recent_visits', v.quiet_since, jsonb_build_object('last_visit', v.last_visit)
  from (select o.id, l.last_visit, coalesce(l.last_visit, l.live_at) as quiet_since, l.live_at
        from app.organizations o,
        lateral (select (select min(q.created_at) from app.queues q
                         where q.org_id = o.id and q.archived_at is null and q.manual_state = 'open') as live_at,
                        (select max(x.joined_at) from app.visits x where x.org_id = o.id) as last_visit) l
        where o.status = 'active') v
  where v.live_at < now() - interval '7 days'
    and v.quiet_since < now() - interval '7 days' and v.quiet_since > now() - interval '30 days'
$$;
revoke all on function private.platform_attention_raw() from public, anon, authenticated;

create type api.platform_attention_row as (
  org_id uuid,
  name text,
  org_status app.org_status,
  reason text,
  priority int,
  since timestamptz,
  detail jsonb,
  -- How many items are open in total, before p_limit.
  total int
);
grant usage on type api.platform_attention_row to authenticated;

create function api.platform_attention(p_limit int default 50)
returns setof api.platform_attention_row
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('support');
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'invalid_input';
  end if;
  return query
  select x.org_id, x.name, x.org_status, x.reason, x.priority, x.since, x.detail, (count(*) over ())::int
  from (
    select r.org_id, o.name, o.status as org_status, r.reason, private.attention_priority(r.reason) as priority,
           r.since, r.detail
    from private.platform_attention_raw() r
    join app.organizations o on o.id = r.org_id
    where not exists (select 1 from app.platform_attention_acks k
                      where k.org_id = r.org_id and k.reason = r.reason and k.snooze_until > now())
  ) x
  order by x.priority, x.since, x.org_id
  limit p_limit;
end $$;
comment on function api.platform_attention(int) is
  'Support or operator with aal2: tenants that need a human, one row per (org, reason), most urgent first '
  '(priority, then the oldest since). Reasons: support_request_open, payment_past_due, sms_auto_paused, '
  'pending_deletion, tagged_attention, message_failures, device_offline, plan_limit, login_lockout, stuck_onboarding, '
  'no_recent_visits; thresholds are documented on private.platform_attention_raw. since is when the '
  'condition began, detail the numbers behind it, total the count before p_limit. An item acknowledged '
  'with api.platform_ack_attention is hidden until its snooze ends; a different reason for the same '
  'org is a different item. Counts, names and staff-written text only; no guest data. Raises '
  'permission_denied (42501) without a platform role and aal2, invalid_input for p_limit outside 1-200.';

create function api.platform_ack_attention(p_org_id uuid, p_reason text, p_hours int) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_platform('support');
  if private.attention_priority(p_reason) is null or p_hours is null or p_hours not between 0 and 720 then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from app.organizations where id = p_org_id) then
    raise exception 'not_found';
  end if;
  if p_hours = 0 then
    -- Un-snooze. Repeating it is a no-op, and so is clearing something never acknowledged.
    if exists (select 1 from app.platform_attention_acks where org_id = p_org_id and reason = p_reason) then
      delete from app.platform_attention_acks where org_id = p_org_id and reason = p_reason;
      perform private.platform_audit('attention.unack', p_org_id, jsonb_build_object('reason', p_reason), null);
    end if;
    return;
  end if;
  insert into app.platform_attention_acks (org_id, reason, acked_by, acked_at, snooze_until)
  values (p_org_id, p_reason, (select auth.uid()), now(), now() + make_interval(hours => p_hours))
  on conflict (org_id, reason) do update
    set acked_by = excluded.acked_by, acked_at = excluded.acked_at, snooze_until = excluded.snooze_until;
  perform private.platform_audit('attention.ack', p_org_id,
                                 jsonb_build_object('reason', p_reason, 'hours', p_hours), null);
end $$;
comment on function api.platform_ack_attention(uuid, text, int) is
  'Support or operator with aal2: hides one attention item (org and reason) for 1-720 hours, or shows it '
  'again with 0 hours. Acknowledging again restarts the snooze. Written to platform_audit with who, '
  'when and for how long. Raises permission_denied (42501) without a platform role and aal2, '
  'invalid_input for an unknown reason or hours outside 0-720, not_found for an unknown org.';

revoke all on function api.platform_attention(int), api.platform_ack_attention(uuid, text, int) from public, anon;
grant execute on function api.platform_attention(int), api.platform_ack_attention(uuid, text, int) to authenticated;

notify pgrst, 'reload schema';
