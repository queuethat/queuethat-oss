-- #1130 (epic #1128): platform support's message and webhook delivery log. Metadata only:
-- channel, template trigger, status, error code, attempts, timestamps and a MASKED recipient.
-- Never a message body, variables, full address, webhook payload or URL path (I-13).

create type api.platform_delivery_row as (
  -- 'message' (app.notifications) or 'webhook' (app.webhook_deliveries)
  kind text,
  id uuid,
  org_id uuid,
  org_name text,
  created_at timestamptz,
  updated_at timestamptz,
  -- push, email, sms, whatsapp, telegram, console, or webhook
  medium text,
  -- The template trigger (called, almost_up...) or the webhook event type
  template_key text,
  -- queued, claimed, sent, failed, dead, suppressed (messages); queued, claimed, delivered, failed, dead (webhooks)
  status text,
  -- Provider's last delivery report for messages: delivered, undelivered, failed, ...
  delivery_status text,
  error_code text,
  attempts int,
  provider text,
  -- Why the address is on the org's suppression list (stop, bounce, complaint, manual, platform_stop), or null
  suppression_reason text,
  -- j***@example.com, ******42, or a webhook's host; null for push and for a recipient that was deleted
  recipient_masked text
);

create type api.platform_delivery_summary_row as (
  medium text,
  provider text,
  sent int,
  failed int,
  suppressed int,
  pending int,
  -- failed / (sent + failed), 0 when neither
  failure_rate double precision
);
grant usage on type api.platform_delivery_row, api.platform_delivery_summary_row to authenticated;

/** 'j***@example.com' for an email, '******42' (last two digits) for a phone, null for null. */
create function private.mask_delivery_recipient(p_value text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_value is null or btrim(p_value) = '' then null
    when position('@' in p_value) > 1 then left(p_value, 1) || '***' || substring(p_value from position('@' in p_value))
    when position('@' in p_value) = 1 then '***' || p_value
    else '******' || case when length(regexp_replace(p_value, '\D', '', 'g')) > 2
                          then right(regexp_replace(p_value, '\D', '', 'g'), 2) else '' end
  end
$$;
comment on function private.mask_delivery_recipient(text) is
  'Masks an email (first character and domain kept) or a phone number (last two digits kept). Never returns more than that.';

/**
 * A provider's error code as the log may show it: a short token, never free text. Providers
 * choose these codes, so anything that could carry an address, a phone number or a sentence is
 * replaced by 'other' rather than trusted.
 */
create function private.safe_error_code(p_code text) returns text
language sql immutable set search_path = '' as $$
  select case when p_code is null then null
              when p_code ~ '^[A-Za-z0-9_.:-]{1,64}$' and p_code !~ '[0-9]{6,}' then p_code
              else 'other' end
$$;
comment on function private.safe_error_code(text) is
  'Returns an error code that is a short token without long digit runs, else other. Null stays null.';
revoke all on function private.safe_error_code(text) from public, anon, authenticated;

create index notifications_org_created_idx on app.notifications (org_id, created_at desc, id desc);
create index notifications_created_idx on app.notifications (created_at);
create index webhook_deliveries_created_idx on app.webhook_deliveries (created_at);

create function api.platform_org_deliveries(
  p_org_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_status text default null,
  p_channel text default null,
  p_limit int default 50,
  p_after_at timestamptz default null,
  p_after_id uuid default null
) returns setof api.platform_delivery_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_rows api.platform_delivery_row[];
begin
  perform private.require_platform('support');
  if p_limit is null or p_limit not between 1 and 200
     or (p_after_at is null) <> (p_after_id is null)
     or length(p_status) > 32 or length(p_channel) > 32
     or (p_from is not null and p_to is not null and p_from >= p_to)
     -- All tenants at once only for problems: a failures view, never a browse of every message.
     or (p_org_id is null and coalesce(p_status, '') not in ('failed', 'dead', 'suppressed')) then
    raise exception 'invalid_input';
  end if;
  if p_org_id is not null and not exists (select 1 from app.organizations where id = p_org_id) then
    raise exception 'not_found';
  end if;

  select coalesce(array_agg(r order by r.created_at desc, r.id desc), '{}') into v_rows
  from (
    select * from (
      select 'message'::text as kind, n.id, n.org_id, o.name as org_name, n.created_at, n.updated_at,
             n.channel::text as medium, n.template_key, n.status::text as status, n.delivery_status,
             private.safe_error_code(n.error_code), n.attempts, n.provider,
             case when n.status = 'suppressed' then (
               select s.reason from app.suppressions s
               where s.org_id = n.org_id and s.channel = n.channel
                 and s.value = lower(private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id))
               limit 1) end as suppression_reason,
             private.mask_delivery_recipient(private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id))
               as recipient_masked
      from app.notifications n
      join app.organizations o on o.id = n.org_id
      where (p_org_id is null or n.org_id = p_org_id)
        and (p_channel is null or n.channel::text = p_channel)
        and (p_status is null or n.status::text = p_status)
        and (p_from is null or n.created_at >= p_from)
        and (p_to is null or n.created_at < p_to)
        and (p_after_at is null or (n.created_at, n.id) < (p_after_at, p_after_id))
      order by n.created_at desc, n.id desc
      limit p_limit
    ) m
    union all
    select * from (
      select 'webhook', d.id, d.org_id, o.name, d.created_at, d.created_at,
             'webhook', d.event_type, d.status, null::text,
             -- The receiver's own error text can echo a response body; only its status is shown.
             case when d.response_status is not null and d.status in ('failed', 'dead') then 'http_' || d.response_status
                  when d.error is not null then 'delivery_error' end,
             d.attempts, null::text, null::text,
             substring(e.url from '^https?://([^/:?#]+)')
      from app.webhook_deliveries d
      join app.organizations o on o.id = d.org_id
      join app.webhook_endpoints e on e.id = d.endpoint_id
      where (p_channel is null or p_channel = 'webhook')
        and (p_org_id is null or d.org_id = p_org_id)
        and (p_status is null or d.status = p_status)
        and (p_from is null or d.created_at >= p_from)
        and (p_to is null or d.created_at < p_to)
        and (p_after_at is null or (d.created_at, d.id) < (p_after_at, p_after_id))
      order by d.created_at desc, d.id desc
      limit p_limit
    ) w
    order by 5 desc, 2 desc
    limit p_limit
  ) r;

  perform private.platform_audit('deliveries.read', p_org_id,
    jsonb_build_object('status', p_status, 'channel', p_channel, 'from', p_from, 'to', p_to,
                       'rows', coalesce(array_length(v_rows, 1), 0)), null);
  return query select (x).* from unnest(v_rows) x;
end $$;
comment on function api.platform_org_deliveries(uuid, timestamptz, timestamptz, text, text, int, timestamptz, uuid) is
  'Support or operator with aal2, no support grant needed: one tenant''s message and webhook '
  'deliveries, newest first, created in [p_from, p_to), optionally by status and channel (webhook '
  'selects webhooks). Page with p_after_at and p_after_id = the created_at and id of the last row seen; '
  'both or neither. p_org_id null lists failed, dead or suppressed rows of every tenant (p_status '
  'required). Rows carry a masked recipient and error codes only: never a body, variables, a full '
  'address, a webhook payload or URL path. Works for suspended orgs. Every call is written to '
  'platform_audit (deliveries.read) with the org id and filters. Raises permission_denied (42501) '
  'without a platform role and aal2, invalid_input for p_limit outside 1-200, a half cursor, '
  'a status or channel over 32 characters, p_from >= p_to, or a null org without a failure status, not_found for an unknown org.';

create function api.platform_delivery_summary(p_from timestamptz, p_to timestamptz)
returns setof api.platform_delivery_summary_row
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('support');
  if p_from is null or p_to is null or p_from >= p_to or p_to - p_from > interval '31 days' then
    raise exception 'invalid_input';
  end if;
  return query
  select t.medium, t.provider,
         (count(*) filter (where t.status in ('sent', 'delivered')))::int,
         (count(*) filter (where t.status in ('failed', 'dead')))::int,
         (count(*) filter (where t.status = 'suppressed'))::int,
         (count(*) filter (where t.status in ('queued', 'claimed')))::int,
         coalesce((count(*) filter (where t.status in ('failed', 'dead')))::double precision
           / nullif(count(*) filter (where t.status in ('sent', 'delivered', 'failed', 'dead')), 0), 0)
  from (
    select n.channel::text as medium, coalesce(n.provider, 'none') as provider, n.status::text as status
    from app.notifications n where n.created_at >= p_from and n.created_at < p_to
    union all
    select 'webhook', 'webhook', d.status
    from app.webhook_deliveries d where d.created_at >= p_from and d.created_at < p_to
  ) t
  group by t.medium, t.provider
  order by t.medium, t.provider;
end $$;
comment on function api.platform_delivery_summary(timestamptz, timestamptz) is
  'Support or operator with aal2: message and webhook counts by channel and provider across all '
  'tenants in [p_from, p_to): sent, failed (failed + dead), suppressed, pending, and failure_rate = '
  'failed / (sent + failed). Counts only; no tenant or contact data. Raises permission_denied (42501) '
  'without a platform role and aal2, invalid_input for a null bound, p_from >= p_to or a range over 31 days.';

revoke all on function api.platform_org_deliveries(uuid, timestamptz, timestamptz, text, text, int, timestamptz, uuid),
  api.platform_delivery_summary(timestamptz, timestamptz) from public, anon;
grant execute on function api.platform_org_deliveries(uuid, timestamptz, timestamptz, text, text, int, timestamptz, uuid),
  api.platform_delivery_summary(timestamptz, timestamptz) to authenticated;
revoke all on function private.mask_delivery_recipient(text) from public, anon, authenticated;
