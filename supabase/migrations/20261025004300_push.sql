-- N4 (#70): web push. Guests register a subscription for their visit, and a push service that
-- reports the subscription gone gets it deleted. Sending is packages/providers webpush channel.

------------------------------------------------------------------------------------------------
-- api.guest_register_push (signature and grants from S5, 20261025000600_api_contracts.sql)
------------------------------------------------------------------------------------------------

/**
 * Push services the dispatcher may POST to. Subscriptions come from browsers, so anything else
 * is a forged endpoint, and sending to it would make the dispatcher an open request relay.
 */
create function private.is_push_endpoint(p_endpoint text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(length(p_endpoint) <= 1024 and p_endpoint ~ ('^https://('
    || 'fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com'
    || '|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com'
    || ')/[!-~]+$'), false)
$$;
comment on function private.is_push_endpoint(text) is
  'True for an https URL on a known browser push service (FCM, Mozilla, Apple, WNS).';

-- redefines api.guest_register_push from 20261025000600_api_contracts.sql
create or replace function api.guest_register_push(
  p_token text, p_endpoint text, p_p256dh text, p_auth text
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_p256dh text := rtrim(p_p256dh, '=');
  v_auth text := rtrim(p_auth, '=');
begin
  v := private.visit_by_token(p_token);
  -- p256dh is a 65-byte P-256 point and auth a 16-byte secret, both base64url.
  if not private.is_push_endpoint(p_endpoint)
     or v_p256dh !~ '^[A-Za-z0-9_-]{87}$' or v_auth !~ '^[A-Za-z0-9_-]{22}$'
     or v_p256dh is null or v_auth is null then
    raise exception 'invalid_input';
  end if;

  insert into app.push_subscriptions (org_id, visit_id, endpoint, p256dh, auth)
  values (v.org_id, v.id, p_endpoint, v_p256dh, v_auth)
  on conflict (visit_id, endpoint) do nothing;
  if found then
    -- One guest has a few browsers at most; keep the newest five so a token can't grow the table.
    delete from app.push_subscriptions s
    where s.visit_id = v.id and s.id not in (
      select k.id from app.push_subscriptions k where k.visit_id = v.id
      order by k.created_at desc, k.id desc limit 5);
  end if;
end $$;
comment on function api.guest_register_push(text, text, text, text) is
  'Stores a Web Push subscription for the token''s visit; pushes for its called and almost-up '
  'events go to it until the push service reports it gone. Repeating it with the same endpoint '
  'changes nothing; a visit keeps its five newest subscriptions. Raises not_found as '
  'get_visit_status does, invalid_input for an endpoint that is not https on a known push '
  'service (FCM, Mozilla, Apple, WNS) or keys that are not base64url of the right length. '
  'Implemented in N4 (#70).';

revoke all on function private.is_push_endpoint(text) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- api.report_outbox_result (N3, 20261025003000_outbox_rpcs.sql): gone deletes the subscription
------------------------------------------------------------------------------------------------

-- redefines api.report_outbox_result from 20261025003000_outbox_rpcs.sql
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

  -- A push service that answers 404/410 has dropped the subscription for good.
  if v_status = 'gone' and n.channel = 'push' then
    delete from app.push_subscriptions s where s.id = n.recipient_ref and s.org_id = n.org_id;
  end if;
end $$;
comment on function api.report_outbox_result(uuid, jsonb) is
  'Records a send outcome {status: sent|failed|suppressed|gone, provider, provider_message_id, '
  'error_code, retryable, segments, cost_micros} for a row the caller has claimed. A retryable '
  'failure is retried after 30 s, doubling each time; the sixth failed attempt, a non-retryable '
  'failure or gone marks it dead; gone for a push row also deletes its subscription. '
  'suppressed with error_code quiet_hours is retried in 15 '
  'minutes. Reports for rows no longer claimed are ignored. Raises invalid_input, not_found. '
  'Implemented in N3 (#69).';
