-- 3-PV4 (#343): per-message cost ledger. app.notifications carries segments, cost and currency;
-- report_outbox_result fills them (the provider's price, else segments x the rate); usage_summary
-- reads them. Rates are placeholders to verify on each vendor's price page.

alter table app.notifications
  add column currency char(3) not null default 'USD',
  add column cost_source text check (cost_source in ('estimate', 'provider')),
  add column sent_at timestamptz;
grant select (currency, cost_source, sent_at) on app.notifications to authenticated;
comment on column app.notifications.cost_micros is
  'Millionths of `currency` for the whole message; null until sent. cost_source says whether the provider or our rate table set it.';

-- org_id null = a platform default rate; an org row for the same provider, channel and country overrides it.
create table app.provider_rates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references app.organizations (id) on delete cascade,
  provider text not null,
  channel app.notification_channel not null,
  country_code text check (country_code ~ '^[A-Z]{2}$'),
  micros_per_unit bigint not null check (micros_per_unit >= 0),
  currency char(3) not null default 'USD',
  valid_from timestamptz not null default now(),
  note text,
  created_at timestamptz not null default now()
);
create index provider_rates_lookup_idx on app.provider_rates (provider, channel, valid_from desc);
create trigger forbid_org_change before update on app.provider_rates
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.provider_rates
  for each row execute function private.audit_row();

alter table app.provider_rates enable row level security;
create policy provider_rates_select on app.provider_rates for select to authenticated
  using (org_id is not null and (select private.has_role(org_id, null, 'manager')));
create policy provider_rates_insert on app.provider_rates for insert to authenticated
  with check (org_id is not null and (select private.has_role(org_id, null, 'admin')));
create policy provider_rates_update on app.provider_rates for update to authenticated
  using (org_id is not null and (select private.has_role(org_id, null, 'admin')))
  with check (org_id is not null and (select private.has_role(org_id, null, 'admin')));
create policy provider_rates_delete on app.provider_rates for delete to authenticated
  using (org_id is not null and (select private.has_role(org_id, null, 'admin')));
grant select, insert, update, delete on app.provider_rates to authenticated;
grant all on app.provider_rates to service_role;

insert into app.provider_rates (provider, channel, micros_per_unit, note) values
  ('twilio', 'sms', 7900, 'placeholder: verify on vendor page'),
  ('telnyx', 'sms', 4000, 'placeholder: verify on vendor page'),
  ('vonage', 'sms', 6000, 'placeholder: verify on vendor page'),
  ('plivo', 'sms', 5000, 'placeholder: verify on vendor page'),
  ('meta', 'whatsapp', 5000, 'placeholder: verify on vendor page');

-- The rate for one message: the org's own row beats the default, a country row beats a country-less one,
-- the newest valid_from wins. No row means the cost stays unknown (null), never a guess.
create function private.message_rate(p_org_id uuid, p_provider text, p_channel app.notification_channel, p_country text)
returns app.provider_rates
language sql stable security definer set search_path = '' as $$
  select r.* from app.provider_rates r
  where r.provider = p_provider and r.channel = p_channel
    and (r.org_id = p_org_id or r.org_id is null)
    and (r.country_code = p_country or r.country_code is null)
    and r.valid_from <= now()
  order by (r.org_id is null), (r.country_code is null), r.valid_from desc
  limit 1
$$;
comment on function private.message_rate(uuid, text, app.notification_channel, text) is
  'Most specific price per segment for a send: org over default, country over any country, newest first. Null row when none.';
revoke all on function private.message_rate(uuid, text, app.notification_channel, text) from public;
grant execute on function private.message_rate(uuid, text, app.notification_channel, text) to service_role;

-- redefines api.report_outbox_result from 20261025004600_mail_abuse_limits.sql
create or replace function api.report_outbox_result(p_outbox_id uuid, p_result jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  n app.notifications;
  v_status text := p_result ->> 'status';
  v_code text := left(p_result ->> 'error_code', 100);
  v_provider text;
  v_segments int := (p_result ->> 'segments')::int;
  v_cost bigint := (p_result ->> 'cost_micros')::bigint;
  v_source text;
  v_currency char(3);
  v_rate app.provider_rates;
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

  v_provider := coalesce(left(p_result ->> 'provider', 50), n.provider);
  if v_status = 'sent' then
    if v_cost is not null then
      v_source := 'provider';
      v_currency := coalesce(left(p_result ->> 'currency', 3), 'USD');
    elsif n.channel in ('sms', 'whatsapp') then
      -- The provider quoted no price: estimate from the rate table and reconcile later (3-SMS2).
      v_rate := private.message_rate(n.org_id, v_provider, n.channel,
        (select c.country_code from app.guest_contacts c where c.id = n.recipient_ref and c.org_id = n.org_id));
      if v_rate.id is not null then
        v_segments := coalesce(v_segments, 1);
        v_cost := v_segments * v_rate.micros_per_unit;
        v_currency := v_rate.currency;
        v_source := 'estimate';
      end if;
    end if;
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
    provider = v_provider,
    provider_message_id = left(p_result ->> 'provider_message_id', 200),
    error_code = case when v_status = 'gone' then coalesce(v_code, 'gone') else v_code end,
    segments = v_segments,
    cost_micros = v_cost,
    currency = coalesce(v_currency, n.currency),
    cost_source = v_source,
    sent_at = case when v_status = 'sent' then now() else n.sent_at end
  where id = n.id;

  -- A push service that answers 404/410 has dropped the subscription for good.
  if v_status = 'gone' and n.channel = 'push' then
    delete from app.push_subscriptions s where s.id = n.recipient_ref and s.org_id = n.org_id;
  end if;
  -- An email or SMS that is gone bounced hard, or the recipient complained (error_code
  -- complaint); claim_outbox honours both in every org.
  if v_status = 'gone' and n.channel <> 'push' then
    insert into app.suppressions (org_id, channel, value, reason)
    select n.org_id, n.channel, a.value, case when v_code = 'complaint' then 'complaint' else 'bounce' end
    from (select private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)) a (value)
    where a.value is not null
    on conflict (org_id, channel, value) do nothing;
  end if;
end $$;
comment on function api.report_outbox_result(uuid, jsonb) is
  'Records a send outcome {status: sent|failed|suppressed|gone, provider, provider_message_id, '
  'error_code, retryable, segments, cost_micros, currency} for a row the caller has claimed. A sent '
  'SMS or WhatsApp with no cost_micros is priced at segments (default 1) x the provider rate and marked '
  'cost_source estimate; a quoted cost is marked provider. A retryable '
  'failure is retried after 30 s, doubling each time; the sixth failed attempt, a non-retryable '
  'failure or gone marks it dead; gone for a push row also deletes its subscription, and for '
  'email or SMS suppresses the address (reason complaint when error_code is complaint, else bounce). '
  'suppressed with error_code quiet_hours is retried in 15 '
  'minutes. Reports for rows no longer claimed are ignored. Raises invalid_input, not_found. '
  'Implemented in N3 (#69); cost in 3-PV4 (#343).';

-- redefines api.usage_summary from 20261030210404_api_contracts_3.sql
create or replace function api.usage_summary(p_org_id uuid, p_from date, p_to date) returns setof api.usage_row
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'range_too_large';
  end if;
  if not (select private.has_role(p_org_id, null, 'manager')) then
    -- Below manager in this org is a refusal; anyone else sees nothing, as for any foreign org.
    if (select private.has_role(p_org_id, null, 'staff')) then
      raise exception 'permission_denied' using errcode = '42501';
    end if;
    return;
  end if;
  return query
    select (n.sent_at at time zone 'UTC')::date, n.channel::text, coalesce(n.provider, ''), count(*)::int,
           coalesce(sum(n.segments), 0)::int, coalesce(sum(n.cost_micros), 0)::bigint, n.currency::text
    from app.notifications n
    where n.org_id = p_org_id and n.status = 'sent'
      and n.sent_at >= (p_from::timestamp at time zone 'UTC')
      and n.sent_at < ((p_to + 1)::timestamp at time zone 'UTC')
    group by 1, 2, 3, 7
    order by 1, 2, 3;
end $$;
comment on function api.usage_summary(uuid, date, date) is
  'Messages, segments and cost per day, channel and provider (UTC days, both ends inclusive) for sent messages; '
  'suppressed and failed rows cost nothing and are left out. Manager or above; staff get 42501, other callers '
  'no rows. Raises range_too_large for more than 366 days or an inverted range. Implemented in 3-PV4 (#343).';
