-- 4-WL1 (#376): an org can hide the product name and logo where guests see them. The source offer
-- stays (AGPL-3.0 s13), so clients render it unconditionally; this only carries the flag.
--   * organizations.hide_product_branding: owners only (a trigger, because the update policy admits admins).
--   * api.get_location_branding gains hide_product_branding (Alternative considered: a second public
--     RPC; rejected, branding already has one anon read and clients fetch it once per page).
--   * api.claim_outbox puts it in each row's vars as org_hide_product_branding, overwriting any stored
--     value, so the email footer follows the flag at send time.

alter table app.organizations add column hide_product_branding boolean not null default false;
grant update (hide_product_branding) on app.organizations to authenticated, service_role;
comment on column app.organizations.hide_product_branding is
  'Hides the product name on guest pages, displays and email. The source-code link is always shown. Owners only.';

create function private.owner_only_white_label() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.hide_product_branding is distinct from old.hide_product_branding
     and (select auth.uid()) is not null
     and not (select private.has_role(new.id, null, 'owner')) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger owner_only_white_label before update on app.organizations
  for each row execute function private.owner_only_white_label();

alter type api.location_branding add attribute hide_product_branding boolean;

-- redefines api.get_location_branding from 20261030064042_branding.sql
create or replace function api.get_location_branding(p_slug text) returns api.location_branding
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
  o app.organizations;
begin
  select * into l from app.locations where slug = p_slug;
  if not found then
    select loc.* into l
    from app.slug_redirects r join app.locations loc on loc.id = r.location_id
    where r.old_slug = p_slug;
  end if;
  if l.id is null then
    raise exception 'not_found';
  end if;
  select * into o from app.organizations where id = l.org_id;
  return row(
    o.name,
    case when o.logo_path is not null then '/storage/v1/object/public/branding/' || o.logo_path end,
    case when l.cover_path is not null then '/storage/v1/object/public/branding/' || l.cover_path end,
    o.brand_primary, o.brand_accent, l.welcome_text, l.terms_url, l.privacy_url,
    o.hide_product_branding
  )::api.location_branding;
end $$;
comment on function api.get_location_branding(text) is
  'Public branding of the location (by slug or a retired slug): organization name, logo and cover '
  'as paths under the API origin (/storage/v1/object/public/branding/...), brand colours as #rrggbb, '
  'plain-text welcome text, https terms and privacy links, and hide_product_branding (true: clients omit '
  'the product name, never the source link). Anon-callable and read-only; nothing else about the org or '
  'location is returned. Raises not_found for an unknown slug.';
revoke all on function api.get_location_branding(text) from public;
grant execute on function api.get_location_branding(text) to anon, authenticated;

-- redefines api.claim_outbox from 20261030221745_quiet_hours.sql
create or replace function api.claim_outbox(p_limit int, p_lease_seconds int) returns setof api.outbox_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 200
     or p_lease_seconds is null or p_lease_seconds not between 1 and 600 then
    raise exception 'invalid_input';
  end if;

  -- Quiet hours (3-CG9): a non-urgent row whose location is outside its send window waits for the
  -- next opening instead of being claimed, so a deferral costs no attempt and no dispatcher call.
  -- Urgent: called and help_reply. Push (the guest's own device, actively waiting) and account mail
  -- (no location) are exempt, matching policy.ts.
  update app.notifications n
  set next_attempt_at = w.opens, quiet_hours_deferred = true
  from (select x.id, private.next_send_window(l.id, now()) as opens
        from app.notifications x
        left join app.visits v on v.id = x.visit_id
        left join app.appointments ap on ap.id = x.appointment_id
        join app.locations l on l.id = coalesce(v.location_id, ap.location_id)
        where x.status in ('queued', 'failed') and x.next_attempt_at <= now()
          and x.channel <> 'push' and x.template_key not in ('called', 'help_reply')
        for update of x skip locked) w
  where n.id = w.id and w.opens > now();

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
        consent_id = case when n.channel = 'push' or (n.visit_id is null and n.appointment_id is null) then null else (
          select c.id from app.consents c
          where c.contact_id = n.recipient_ref and c.channel = n.channel and c.purpose = n.category
          order by c.captured_at desc limit 1) end,
        recipient_hash = case when n.channel <> 'push' and (n.visit_id is not null or n.appointment_id is not null) then
          encode(sha256(convert_to(private.canonical_email(
            private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)), 'UTF8')), 'hex')
        end
    from due
    where n.id = due.id
    returning n.*
  )
  select n.id, n.org_id, n.visit_id, n.channel, n.category, n.template_key, n.template_version,
         coalesce(v.locale, ap.locale, o.default_locale), t.subject, t.body, (case when n.category = 'marketing' then
              n.vars || jsonb_build_object('org_legal_name', o.legal_name, 'org_postal_address', o.postal_address)
              else n.vars end) || jsonb_build_object('org_hide_product_branding', o.hide_product_branding),
         case when n.channel = 'push' then
                (select jsonb_build_object('kind', 'push', 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)
                 from app.push_subscriptions s where s.id = n.recipient_ref)
              when a.value is not null then jsonb_build_object('kind', 'address', 'value', a.value)
         end,
         -- A push subscription is its own opt-in, and account mail is part of the service the
         -- member signed up for; other channels need the latest consent granted.
         n.channel = 'push' or (n.visit_id is null and n.appointment_id is null)
           -- Decision 20 (#398): an email typed at join consents to transactional mail about
           -- that visit only. The visit row (source, joined_at) is the record, and relevance ends
           -- it with the visit. SMS needs its own explicit consent (TCPA); marketing never rides.
           or (n.recipient_ref = coalesce(n.visit_id, n.appointment_id) and n.channel = 'email' and n.category = 'transactional')
           or coalesce((select c.status = 'granted' and c.revoked_at is null
                        from app.consents c where c.id = n.consent_id), false),
         n.channel <> 'push' and (
           -- The org's own list, plus bounces and complaints from any org: the address is dead
           -- or unwilling everywhere.
           exists (select 1 from app.suppressions sp
                   where sp.channel = n.channel and private.canonical_email(sp.value) = private.canonical_email(a.value)
                     and (sp.org_id = n.org_id or sp.reason in ('bounce', 'complaint')))
           -- Guest messages per address across the platform, so joins at many venues with one
           -- typed address can't flood it. Rows other batches hold count too; rows in this
           -- batch don't, so one batch can overshoot.
           or (n.recipient_hash is not null and (
                 select count(*) from app.notifications s
                 where s.recipient_hash = n.recipient_hash and s.status in ('claimed', 'sent')
                   and s.updated_at > now() - interval '1 day') >= private.address_daily_cap())),
         l.tz, n.attempts,
         null::text -- tokens are stored hashed, so no message can link to the status page
  from claimed n
  join app.organizations o on o.id = n.org_id
  cross join lateral (select private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)) a (value)
  -- Account mail has no visit or appointment, so no location time zone either.
  left join app.visits v on v.id = n.visit_id
  left join app.appointments ap on ap.id = n.appointment_id
  left join app.locations l on l.id = coalesce(v.location_id, ap.location_id)
  left join lateral private.resolve_template(n.org_id, coalesce(v.queue_id, ap.queue_id), n.template_key, n.channel,
                                             coalesce(v.locale, ap.locale, o.default_locale)) t on true;
end $$;
