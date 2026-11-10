-- #456: a total ceiling on online joins per queue that no client identity can bypass.
--
-- The per-client limit (20261025004110_join_hardening.sql) keys on client identity, and fresh
-- IPv6 /64s are cheap: the security review of #441 and #452 made 200 online joins to one queue
-- from rotating addresses. The per-minute backstop caps the rate at three times
-- join_rate_per_min, but a sustained flood still adds thousands of visits an hour, which ruins
-- every real guest's ETA. online_joins_per_hour caps the total. Kiosk and staff joins are not
-- counted and not limited by it, so an online flood can't stop walk-ins from being added.

alter table app.queues
  -- Online joins accepted per rolling hour, from all clients together.
  add column online_joins_per_hour int not null default 120 check (online_joins_per_hour > 0);

-- The ceiling counts this queue's online visits in the last hour on every online join, under the
-- queue lock. Without it, that count reads every visit the queue ever had.
create index visits_queue_online_joined_idx on app.visits (queue_id, joined_at) where source = 'online';

------------------------------------------------------------------------------------------------
-- redefines private.take_join_slot from 20261025004110_join_hardening.sql
-- take_join_slot: the 20261025004110_join_hardening.sql body plus the hourly ceiling for online
-- joins (DETAIL queue_total), checked after the per-client and per-minute limits
------------------------------------------------------------------------------------------------

/**
 * Rate limits for one join, taken inside join_core under its per-queue lock. Raises rate_limited
 * with DETAIL client, queue, queue_total or device; otherwise records the join so later calls
 * count it (the row rolls back with the join if anything after this fails). Staff adds are not
 * limited.
 */
create or replace function private.take_join_slot(p_queue app.queues, p_source text) returns void
language plpgsql volatile set search_path = '' as $$
declare
  -- A person joins one queue a few times at most; venue Wi-Fi puts many guests behind one IP.
  per_client_online constant int := 10;
  per_client_window constant interval := interval '10 minutes';
  v_client bytea := private.client_key();
  v_recent int;
  v_queue_recent int;
begin
  if p_source = 'staff' then
    return;
  end if;

  -- Each kiosk gets join_rate_per_min to itself, so online floods never reach the front desk.
  if p_source = 'kiosk' then
    if (select count(*) from private.join_log l
        where l.queue_id = p_queue.id and l.client_key = v_client and l.at > now() - interval '1 minute')
       >= p_queue.join_rate_per_min then
      raise exception 'rate_limited' using detail = 'device';
    end if;
  else
    -- Online: per client first.
    select count(*) into v_recent from private.join_log l
    where l.queue_id = p_queue.id and l.client_key = v_client and l.at > now() - per_client_window;
    if v_recent >= per_client_online then
      raise exception 'rate_limited' using detail = 'client';
    end if;
    -- Then, while the queue gets more than join_rate_per_min online joins a minute, each client
    -- gets one: anyone who joined in the window waits, but a guest who has not still gets in.
    -- Unknown callers count as having joined. The newcomer exemption stops at three times the
    -- rate, because fresh IPv6 /64s are cheap (one /48 holds 65,536 of them).
    select count(*) into v_queue_recent from app.visits v
    where v.queue_id = p_queue.id and v.source = 'online' and v.joined_at > now() - interval '1 minute';
    if v_queue_recent >= 3 * p_queue.join_rate_per_min
       or ((v_client is null or v_recent > 0) and v_queue_recent >= p_queue.join_rate_per_min) then
      raise exception 'rate_limited' using detail = 'queue';
    end if;
    -- Finally the total for the hour, whoever is asking. Visits that left or were served still
    -- count, so leaving and rejoining from new addresses gains nothing. Visits staff removed don't:
    -- clearing junk joins gives the slots back to real guests.
    if (select count(*) from app.visits v
        where v.queue_id = p_queue.id and v.source = 'online' and v.status <> 'removed'
          and v.joined_at > now() - interval '1 hour')
       >= p_queue.online_joins_per_hour then
      raise exception 'rate_limited' using detail = 'queue_total';
    end if;
  end if;

  if v_client is not null then
    insert into private.join_log (queue_id, client_key) values (p_queue.id, v_client);
  end if;
end $$;
revoke all on function private.take_join_slot(app.queues, text) from public, anon, authenticated;
comment on function private.take_join_slot(app.queues, text) is
  'Join rate limits, called by private.join_core under its queue lock. Raises rate_limited with '
  'DETAIL client (10 online joins per client per queue in 10 minutes), queue (the per-minute '
  'backstop at join_rate_per_min, newcomers up to three times it), queue_total (the queue already '
  'took online_joins_per_hour online joins in the last hour, from any clients, not counting '
  'visits staff removed) or device (a kiosk '
  'over join_rate_per_min a minute). Kiosk and staff joins never count toward the online limits.';

------------------------------------------------------------------------------------------------
-- COMMENT only: the join_core and join_queue bodies are unchanged
------------------------------------------------------------------------------------------------

comment on function private.join_core(uuid, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid) is
  'Adds a waiting visit for every join entry point, bumps the queue version, and returns its id '
  'and plaintext token (stored only as private.token_hash). Repeating (queue, key) returns the '
  'first visit with a null token and changes nothing, even after the queue stopped accepting. '
  'Concurrent joins to one queue are serialized and never deadlock. Order of checks: input '
  '(invalid_input), queue and service (not_found; a kiosk outside the queue''s location, or of a '
  'non-active org, also gets not_found), the accepting predicate (org_suspended when the org is '
  'not active, capacity_reached when full, queue_not_accepting with the reason as DETAIL), then '
  'rate limits (rate_limited, DETAIL client, queue, queue_total or device): online joins at most '
  '10 per client per queue in 10 minutes; while the queue has join_rate_per_min online joins in '
  'the last minute only clients that have not joined it in 10 minutes get in, up to three times '
  'that rate; at most online_joins_per_hour (default 120) online joins per queue in any hour, '
  'from all clients together (visits staff removed don''t count); each kiosk join_rate_per_min per minute on its own; staff '
  'unlimited. Kiosk and staff joins are never counted against online limits. The phone and email '
  'are stored on the visit. Only staff adds also create or link the org''s guest_contacts row and '
  'guest.';

comment on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid) is
  'The one join interface for every source (anon guest, kiosk device; source is derived from the '
  'caller, never a parameter). Idempotent per (queue, p_idempotency_key): repeating a call returns '
  'the same visit, with a fresh token only on the first call and null afterwards, even once the '
  'queue has stopped accepting. Client values for priority, status, org or ticket are never '
  'accepted. Blank name, phone, email or locale count as not given; party size defaults to 1. '
  'The phone and email are kept on the visit for its own messages and never linked to an '
  'existing guest. Raises queue_not_accepting (paused, closed or outside hours; the reason is the '
  'DETAIL), org_suspended (the org is not active), capacity_reached, rate_limited (DETAIL client, '
  'queue, queue_total or device: per client, per queue per minute, per queue per hour from all '
  'clients, or per kiosk), not_found (unknown queue or service, or a kiosk of another location), '
  'invalid_input (bad name, phone, email, party size, locale, or no key). Later phases append '
  'parameters with defaults; never add join_* variants. Implemented in V1 (#30).';
