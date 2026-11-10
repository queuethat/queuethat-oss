-- C7 (#1273): the business's privacy officer and breach contact (epic #1267, design section 4).
--
-- One row per org. Required (DB-enforced) before a sensitive intake field goes live and before SMS is
-- switched on; the agreement/waiver field (W1) calls the same private.privacy_contact_recorded.
-- Expand-only: a new table, one trailing attribute on api.location_public (clients ignore unknown
-- fields), a new prerequisite item for SMS. Alternatives considered: columns on app.organizations
-- (a wide root table every member can read, officer details are admin-only) and a new public RPC for
-- the guest notice (one more anon entry point; the notice already loads api.get_location_public).
--
-- redefines private.privacy_contact_recorded from 20261109081353_sensitive_guards.sql
-- redefines private.org_breach_contact from 20261109072053_incident_breach_contact_lint.sql
-- redefines private.channel_missing from 20261101221239_platform_twilio_sms.sql
-- redefines api.get_location_public from 20261031003600_sms_gate.sql

create table app.org_privacy (
  org_id uuid primary key references app.organizations (id) on delete cascade,
  officer_name text not null check (length(btrim(officer_name)) between 1 and 120),
  email text not null check (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text check (phone is null or length(btrim(phone)) between 3 and 40),
  -- Where the business is regulated; picks the regulator links the admin page shows (information, not advice).
  jurisdiction text not null check (jurisdiction in ('ca', 'ca_ab', 'ca_bc', 'ca_qc', 'us', 'eu', 'uk', 'au', 'other')),
  -- Only show_phone: whether guests also see the phone number in the privacy notice.
  notice_prefs jsonb not null default '{}'
    check (jsonb_typeof(notice_prefs) = 'object' and (notice_prefs - 'show_phone') = '{}'
           and coalesce(jsonb_typeof(notice_prefs -> 'show_phone'), 'boolean') = 'boolean'),
  updated_at timestamptz not null default now()
);
comment on table app.org_privacy is
  'The business''s privacy officer and breach contact, one row per org. Admins and owners write it, managers read it; '
  'it is never deleted on its own (it gates sensitive fields and SMS). Name and email (and phone when '
  'notice_prefs.show_phone) are shown in the guest privacy notice via api.get_location_public.';
create trigger forbid_org_change before update on app.org_privacy
  for each row execute function private.forbid_org_change();
create trigger touch_updated_at before update on app.org_privacy
  for each row execute function private.touch_updated_at();
create trigger audit_row after insert or update or delete on app.org_privacy
  for each row execute function private.audit_row();

alter table app.org_privacy enable row level security;
create policy org_privacy_select on app.org_privacy for select to authenticated
  using ((select private.has_role(org_id, null, 'manager')));
create policy org_privacy_insert on app.org_privacy for insert to authenticated
  with check ((select private.has_role(org_id, null, 'admin')));
create policy org_privacy_update on app.org_privacy for update to authenticated
  using ((select private.has_role(org_id, null, 'admin')))
  with check ((select private.has_role(org_id, null, 'admin')));
revoke all on app.org_privacy from anon, authenticated;
grant select, insert, update on app.org_privacy to authenticated;
grant all on app.org_privacy to service_role;

create or replace function private.privacy_contact_recorded(p_org_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.org_privacy p where p.org_id = p_org_id)
$$;
comment on function private.privacy_contact_recorded(uuid) is
  'True when the org has recorded a privacy officer and breach contact (app.org_privacy). The one '
  'predicate behind the sensitive-field, SMS and agreement gates; callers raise invalid_input with '
  'DETAIL privacy_contact_required (SMS: channel_prerequisite_missing with privacy_contact).';

create or replace function private.org_breach_contact(p_org_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('name', p.officer_name, 'email', p.email, 'phone', p.phone)
  from app.org_privacy p where p.org_id = p_org_id
$$;

-- channel_missing: SMS also needs the privacy contact.
create or replace function private.channel_missing(p_org_id uuid, p_channel text) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  f app.platform_flags;
  s app.provider_settings;
  l app.channel_limits;
  missing text[] := '{}';
begin
  select * into f from app.platform_flags;
  select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel;
  if p_channel = 'sms' and not private.privacy_contact_recorded(p_org_id) then
    missing := array_append(missing, 'privacy_contact');
  end if;
  if p_channel in ('sms', 'whatsapp') and not private.entitled(p_org_id, 'paid_channels') then
    missing := array_append(missing, 'plan_allows_paid_channels');
  end if;
  -- the SMS compliance gate and the provider test event do not apply to an LLM key
  if p_channel not in ('llm', 'pos', 'crm') and f.compliance_gate_passed_at is null then missing := array_append(missing, 'compliance_gate'); end if;
  if not found then
    return array_append(missing, 'provider_settings');
  end if;
  if s.mode = 'platform' and f.hosted_legal_reviewed_at is null then missing := array_append(missing, 'hosted_legal_review'); end if;
  -- The deployment's kill switch holds for orgs already enabled (get_channel_config re-checks on every dispatch).
  if s.mode = 'platform' and not (select d.platform_messaging_enabled from private.deployment_settings d) then
    missing := array_append(missing, 'platform_messaging');
  end if;
  -- Platform-paid SMS is only for billed orgs: with billing off nobody is charged for it.
  if s.mode = 'platform' and p_channel = 'sms' and not private.billing_enabled() then
    missing := array_append(missing, 'platform_requires_billing');
  end if;
  if s.verified_at is null and p_channel <> 'llm' then missing := array_append(missing, 'provider_verified'); end if;
  if p_channel = 'sms' then
    select * into l from app.channel_limits where org_id = p_org_id and channel = 'sms';
    -- no row means the defaults: a cap of 200 and no allowed country
    if coalesce(l.daily_cap, 200) <= 0 then missing := array_append(missing, 'daily_cap'); end if;
    if coalesce(cardinality(l.country_allowlist), 0) = 0 then missing := array_append(missing, 'country_allowlist'); end if;
    -- A US campaign is needed unless the sender is known to be outside +1 and no allowed country shares +1
    -- (the allowlist is matched against the number's calling code, so CA admits US numbers too).
    if (exists (select 1 from app.dial_codes d where d.prefix = '1' and d.country_code = any (coalesce(l.country_allowlist, '{}')))
        or regexp_replace(coalesce(s.config ->> 'from_number', ''), '\s', '', 'g') !~ '^\+'
        or regexp_replace(coalesce(s.config ->> 'from_number', ''), '\s', '', 'g') like '+1%')
       and coalesce(s.messaging_campaign_ref, '') = '' then
      missing := array_append(missing, 'campaign_ref');
    end if;
  end if;
  return missing;
end $$;
revoke all on function private.channel_missing(uuid, text) from public, anon, authenticated;


alter type api.location_public add attribute privacy_contact jsonb;

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
         (select s.turnstile_site_key from private.deployment_settings s),
         (select o.retention_days from app.organizations o where o.id = l.org_id),
         exists (select 1 from app.routing_rules rr join app.queues tq on tq.id = rr.target_queue_id and tq.archived_at is null
                 where rr.location_id = l.id and rr.active),
         private.channel_enabled(l.org_id, 'sms'),
         (select jsonb_strip_nulls(jsonb_build_object(
                   'name', p.officer_name, 'email', p.email,
                   'phone', case when p.notice_prefs ->> 'show_phone' = 'true' then p.phone end))
          from app.org_privacy p where p.org_id = l.org_id)
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
  'no guest data. retention_days is how long the business keeps guest contact details. routing is true when the location has an active routing rule aimed at a live queue: the join page then offers a service picker and joins the location rather than a queue (api.join_queue with p_location_id). sms_enabled is true when the business has switched text messages on (the join page offers the text opt-in only then). Raises not_found for an unknown slug. privacy_contact is {name, email, phone?} of the business''s privacy officer for the guest privacy notice (phone only when the business chose to show it), or null when none is recorded.';

notify pgrst, 'reload schema';
