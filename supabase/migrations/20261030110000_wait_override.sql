-- 2A-Q11 (#110): manual wait override in the ETA (W-5).
-- redefines private.eta_at from 20261029203146_eta_first_free_server.sql
-- redefines api.set_wait_override from 20261030045508_api_contracts_2a.sql
-- Staff know better on unusual days. The override expires on its own, so a forgotten value never
-- lies all evening.

alter type api.eta_state add value 'override';

alter table app.queues
  add column wait_override_minutes int check (wait_override_minutes between 0 and 240),
  add column wait_override_until timestamptz,
  add constraint queues_wait_override_pair check ((wait_override_minutes is null) = (wait_override_until is null));

create or replace function private.eta_at(
  p_queue_id uuid,
  p_before bigint,
  out eta_state api.eta_state,
  out eta_low int,
  out eta_high int
)
language plpgsql stable set search_path = '' as $$
declare
  q app.queues;
  -- Minutes for a visit with no service: the queue's active services on average, else the
  -- services.expected_minutes default.
  v_default numeric;
  v_ahead int;
  v_ahead_work numeric;
  v_avg numeric;
  v_busy_work numeric;
  v_mean numeric;
  v_sigma numeric;
  v_total int;
begin
  select * into q from app.queues where id = p_queue_id;
  if not found then
    return;
  end if;
  if not q.show_eta then
    eta_state := 'hidden';
    return;
  end if;
  if q.manual_state = 'paused' then
    eta_state := 'paused';
    return;
  end if;
  -- Counter sessions do not exist yet; when they do, active sessions replace servers_on_duty here.
  if q.servers_on_duty = 0 then
    eta_state := 'unstaffed';
    return;
  end if;

  select coalesce(avg(s.expected_minutes), 10) into v_default
  from app.services s
  where s.queue_id = q.id and s.active;

  select count(*), coalesce(sum(coalesce(s.expected_minutes, v_default)), 0),
         coalesce(avg(coalesce(s.expected_minutes, v_default)), v_default)
  into v_ahead, v_ahead_work, v_avg
  from app.visits v
  left join app.services s on s.id = v.service_id
  where v.queue_id = q.id and v.status = 'waiting'
    and (p_before is null or v.sort_key < p_before);

  -- Guests being called or served still hold a server: what is left of their expected time,
  -- but never less than a fifth of it.
  select coalesce(sum(greatest(
           0.2 * coalesce(s.expected_minutes, v_default),
           coalesce(s.expected_minutes, v_default)
             - extract(epoch from now() - coalesce(v.serving_at, v.called_at, now())) / 60)), 0)
  into v_busy_work
  from app.visits v
  left join app.services s on s.id = v.service_id
  where v.queue_id = q.id and v.status in ('called', 'serving');

  -- (work ahead + busy) / servers is when the servers would clear everything ahead on average,
  -- but a guest starts as soon as one server frees after the last guest ahead has started, while
  -- the other servers are still mid-service: on average (servers - 1) / servers of half a
  -- service earlier (#548). With one server nothing changes.
  -- 2A-Q11: a manual override replaces the formula until it expires. It is the wait for the whole
  -- line, shared out by place: guest n of n waiting is told the override, earlier guests less.
  if q.wait_override_minutes is not null and q.wait_override_until > now() then
    select count(*)::int into v_total from app.visits v where v.queue_id = q.id and v.status = 'waiting';
    v_mean := q.wait_override_minutes::numeric * (v_ahead + 1) / greatest(v_total, v_ahead + 1);
    eta_low := (round(0.75 * v_mean / 5) * 5)::int;
    eta_high := greatest((ceil(1.25 * v_mean / 5) * 5)::int, eta_low + 5);
    eta_state := case when v_ahead = 0 then 'next' else 'override' end;
    return;
  end if;

  v_mean := greatest(0, (v_ahead_work + v_busy_work) / q.servers_on_duty
                        - (q.servers_on_duty - 1) * v_avg / (2 * q.servers_on_duty));
  v_sigma := 0.5 * v_avg * sqrt(v_ahead + 1) / q.servers_on_duty;
  eta_low := (round(greatest(0, v_mean - v_sigma) / 5) * 5)::int;
  eta_high := greatest((ceil((v_mean + v_sigma) / 5) * 5)::int, eta_low + 5);

  eta_state := case when v_ahead = 0 then 'next' else private.eta_range_state(eta_low, eta_high) end;
end $$;

comment on function private.eta_at(uuid, bigint) is
  'The wait estimate, in minutes until service starts, for a guest placed after every waiting '
  'visit of the queue whose sort_key is below p_before (null = behind all of them). States, '
  'first match wins: hidden (show_eta off), paused, unstaffed (servers_on_duty = 0); then, while '
  'an unexpired staff override is set, next (nobody ahead) or override (the override minutes x '
  '(ahead + 1) / people waiting, +/-25%, in multiples of 5); otherwise next (nobody waiting ahead), '
  'then over_hour, uncertain or ok by private.eta_range_state. hidden, paused and unstaffed carry '
  'no numbers; the others carry low and high in multiples of 5 with high >= low + 5. All nulls for '
  'an unknown queue.';


create or replace function api.set_wait_override(p_queue_id uuid, p_minutes int, p_until timestamptz, p_idempotency_key uuid)
returns api.queue_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  q app.queues;
  l app.locations;
  claim record;
  blocked text;
  v_until timestamptz;
  v_day_end timestamptz;
  result api.queue_row;
begin
  select * into q from app.queues where id = p_queue_id and archived_at is null;
  if not found or not private.has_role(q.org_id, q.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  blocked := private.write_blocked_reason(q.org_id, 'staff', (select auth.uid()));
  if blocked is not null then
    raise exception '%', blocked using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_minutes not between 0 and 240 or p_until <= now() then
    raise exception 'invalid_input';
  end if;

  select * into claim from private.claim_idempotent(q.org_id, 'set_wait_override', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.queue_row, claim.response);
  end if;

  if p_minutes is null then
    update app.queues set wait_override_minutes = null, wait_override_until = null where id = q.id;
  else
    -- Default one hour, never past the end of the service day.
    select * into l from app.locations where id = q.location_id;
    v_day_end := ((private.service_day(l.id) + 1)::timestamp + l.day_boundary) at time zone l.tz;
    v_until := least(coalesce(p_until, now() + interval '60 minutes'), v_day_end);
    update app.queues set wait_override_minutes = p_minutes, wait_override_until = v_until where id = q.id;
  end if;
  perform private.bump_queue_version(q.id);

  result := private.queue_row(q.id);
  perform private.save_idempotent('set_wait_override', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.set_wait_override(uuid, int, timestamptz, uuid) is
  'Sets a temporary wait for the queue: until it expires, every estimate uses p_minutes (0 to 240) '
  'for the whole line (state override). p_until defaults to one hour from now and is cut at the '
  'end of the service day; a null p_minutes clears the override. Staff of the location; audited; '
  'bumps the queue version. Raises invalid_input (minutes out of range, p_until in the past, no '
  'key), not_found for a queue outside the caller''s locations. Idempotent per key. Implemented '
  'by 2A-Q11 (#110).';

notify pgrst, 'reload schema';
