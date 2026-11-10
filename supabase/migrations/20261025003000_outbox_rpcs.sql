-- N3 (#69): the dispatcher's side of the outbox (technical-design.md 3.4). claim_outbox leases due
-- rows with everything a send needs; report_outbox_result records the outcome, backs off failures
-- and dead-letters the sixth. The dispatch-notifications Edge Function is the only caller.

/** A row whose lease ran out was claimed by a dispatcher that died; that run counts as an attempt. */
create function private.outbox_max_attempts() returns int
language sql immutable set search_path = '' as $$ select 6 $$;

create or replace function api.claim_outbox(p_limit int, p_lease_seconds int) returns setof api.outbox_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 200
     or p_lease_seconds is null or p_lease_seconds not between 1 and 600 then
    raise exception 'invalid_input';
  end if;

  update app.notifications
  set status = 'dead', error_code = 'lease_expired', locked_until = null
  where status = 'claimed' and locked_until < now() and attempts + 1 >= private.outbox_max_attempts();

  return query
  with due as (
    select n.id
    from app.notifications n
    where (n.status in ('queued', 'failed') and n.next_attempt_at <= now())
       or (n.status = 'claimed' and n.locked_until < now())
    order by n.next_attempt_at
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update app.notifications n
    set status = 'claimed',
        locked_until = now() + make_interval(secs => p_lease_seconds),
        attempts = n.attempts + case when n.status = 'claimed' then 1 else 0 end,
        consent_id = case when n.channel = 'push' then null else (
          select c.id from app.consents c
          where c.contact_id = n.recipient_ref and c.channel = n.channel and c.purpose = n.category
          order by c.captured_at desc limit 1) end
    from due
    where n.id = due.id
    returning n.*
  )
  select n.id, n.org_id, n.visit_id, n.channel, n.category, n.template_key, n.template_version,
         v.locale, t.subject, t.body, n.vars,
         case when n.channel = 'push' then
                (select jsonb_build_object('kind', 'push', 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)
                 from app.push_subscriptions s where s.id = n.recipient_ref)
              else
                (select jsonb_build_object('kind', 'address', 'value', gc.value)
                 from app.guest_contacts gc where gc.id = n.recipient_ref and gc.org_id = n.org_id)
         end,
         -- A push subscription is its own opt-in; other channels need the latest consent granted.
         n.channel = 'push' or coalesce((select c.status = 'granted' and c.revoked_at is null
                                         from app.consents c where c.id = n.consent_id), false),
         n.channel <> 'push' and exists (
           select 1 from app.suppressions sp join app.guest_contacts gc on gc.id = n.recipient_ref
           where sp.org_id = n.org_id and sp.channel = n.channel and sp.value = gc.value),
         l.tz, n.attempts,
         null::text -- tokens are stored hashed, so no message can link to the status page
  from claimed n
  join app.visits v on v.id = n.visit_id
  join app.locations l on l.id = v.location_id
  left join lateral private.resolve_template(n.org_id, v.queue_id, n.template_key, n.channel, v.locale) t on true;
end $$;
comment on function api.claim_outbox(int, int) is
  'Leases up to p_limit (1-200) due notifications for p_lease_seconds (1-600) and returns them with '
  'recipient (null once deleted), template, consent and suppression facts and the location time '
  'zone. Concurrent dispatchers never receive the same row. A row whose lease expires is due '
  'again and counts as an attempt; at the sixth it is marked dead. Raises invalid_input. '
  'Implemented in N3 (#69).';

create or replace function api.report_outbox_result(p_outbox_id uuid, p_result jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  n app.notifications;
  v_status text := p_result ->> 'status';
  v_code text := left(p_result ->> 'error_code', 100);
begin
  if v_status is null or v_status not in ('sent', 'failed', 'suppressed', 'gone') then
    raise exception 'invalid_input';
  end if;
  select * into n from app.notifications where id = p_outbox_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  -- A report for a row this dispatcher no longer holds (its lease expired) changes nothing.
  if n.status <> 'claimed' then
    return;
  end if;

  update app.notifications set
    status = case
      when v_status = 'sent' then 'sent'
      when v_status = 'suppressed' and v_code = 'quiet_hours' then 'queued'
      when v_status = 'suppressed' then 'suppressed'
      when v_status = 'failed' and coalesce((p_result ->> 'retryable')::boolean, false)
           and n.attempts + 1 < private.outbox_max_attempts() then 'failed'
      else 'dead'
    end::app.notification_status,
    attempts = n.attempts + case when v_status in ('failed', 'gone') then 1 else 0 end,
    -- 30 s, 1, 2, 4, 8 min; quiet hours look again every 15 min until the window opens.
    next_attempt_at = case
      when v_status = 'failed' then now() + interval '30 seconds' * power(2, n.attempts)
      when v_code = 'quiet_hours' then now() + interval '15 minutes'
      else n.next_attempt_at
    end,
    quiet_hours_deferred = n.quiet_hours_deferred or v_code is not distinct from 'quiet_hours',
    locked_until = null,
    provider = coalesce(left(p_result ->> 'provider', 50), n.provider),
    provider_message_id = left(p_result ->> 'provider_message_id', 200),
    error_code = case when v_status = 'gone' then coalesce(v_code, 'gone') else v_code end,
    segments = (p_result ->> 'segments')::int,
    cost_micros = (p_result ->> 'cost_micros')::bigint
  where id = n.id;
end $$;
comment on function api.report_outbox_result(uuid, jsonb) is
  'Records a send outcome {status: sent|failed|suppressed|gone, provider, provider_message_id, '
  'error_code, retryable, segments, cost_micros} for a row the caller has claimed. A retryable '
  'failure is retried after 30 s, doubling each time; the sixth failed attempt, a non-retryable '
  'failure or gone marks it dead. suppressed with error_code quiet_hours is retried in 15 '
  'minutes. Reports for rows no longer claimed are ignored. Raises invalid_input, not_found. '
  'Implemented in N3 (#69).';

revoke all on function private.outbox_max_attempts() from public, anon, authenticated;
