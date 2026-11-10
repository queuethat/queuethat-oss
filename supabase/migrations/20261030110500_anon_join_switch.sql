-- 2A-JN4 (#114): a switch that closes the direct anonymous join. With
-- private.deployment_settings.anon_join_enabled = false, api.join_queue refuses the anon role, so
-- the only anonymous way to create a visit is the public-join Edge Function. The default stays
-- true: guest bundles already in browsers (cached by the service worker) call the RPC directly,
-- and the CAPTCHA and per-IP limits only protect the path once those have aged out. Turning it
-- off is one UPDATE and turning it back on is the rollback; REVOKE EXECUTE would need a migration
-- each way (see docs/ops/public-join.md, "Closing the direct path").

alter table private.deployment_settings
  add column anon_join_enabled boolean not null default true;
comment on column private.deployment_settings.anon_join_enabled is
  'When false, api.join_queue refuses every caller except the service role and paired kiosks (captcha_required, DETAIL public_join): guests join through the public-join Edge Function only.';

-- redefines api.join_queue from 20261030064200_rate_buckets.sql
create or replace function api.join_queue(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_email text,
  p_party_size int,
  p_locale text,
  p_idempotency_key uuid,
  p_device_key text default null,
  p_join_pass text default null,
  p_answers jsonb default '{}'::jsonb,
  p_group_key uuid default null,
  p_onsite_code text default null
) returns api.join_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  joined record;
  result api.join_result;
begin
  if private.device_kind() = 'kiosk' then
    select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
      p_email, p_party_size, p_locale, p_idempotency_key, 'kiosk', 'device', (select auth.uid()),
      null, p_answers, p_group_key, p_onsite_code);
  else
    -- 2A-JN4 (#114): once the deployment turned the direct path off, an anonymous caller has to
    -- come through the public-join Edge Function (service role), which checks the CAPTCHA and
    -- the per-IP limits first. A throwaway signed-up account is no better than anon, so every
    -- caller but the service role is refused here; kiosks took the branch above.
    if (select auth.role()) is distinct from 'service_role'
       and not (select s.anon_join_enabled from private.deployment_settings s) then
      raise exception 'captcha_required' using detail = 'public_join';
    end if;
    -- The public-join Edge Function (service role) has already verified the CAPTCHA with its own
    -- provider (2A-JN2); everyone else needs a Turnstile pass when the deployment has a site key.
    if (select auth.role()) is distinct from 'service_role' then
      perform private.spend_join_pass(p_join_pass, p_queue_id, p_idempotency_key);
    end if;
    select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
      p_email, p_party_size, p_locale, p_idempotency_key, 'online', 'guest', null, p_device_key,
      p_answers, p_group_key, p_onsite_code);
  end if;

  select joined.token, v.display_ticket, v.status into result
  from app.visits v
  where v.id = joined.visit_id;
  return result;
end $$;

comment on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text, jsonb, uuid, text) is
  'The one join interface for every source (anon guest, kiosk device; source is derived from the '
  'caller, never a parameter). Idempotent per (queue, p_idempotency_key), and per (queue, '
  'p_device_key) while that device''s visit is waiting, called or serving: a repeat returns the '
  'same visit and changes nothing, even once the queue has stopped accepting. The token comes back '
  'only to the device that joined (a replayed key needs the same p_device_key; kiosks get their '
  'own visits'' tokens), else null, as for visits older than the token secret. The token is '
  'base64url(HMAC-SHA256(Vault secret guest_token_secret, ''visit:'' || visit_id || '':'' || '
  'idempotency_key)), never stored or rotated; the visit keeps only its sha256. p_device_key is a random id the guest''s browser keeps (22 to 128 '
  'base64url characters); kiosks'' is ignored, since many guests share one. When the deployment '
  'has a Turnstile site key, an online join needs p_join_pass from api.issue_join_pass: unused '
  'and unexpired, or spent within the last day on this same queue and p_idempotency_key (a '
  'replay); a refused join '
  'leaves it unspent. Kiosks need none, and neither does the service role (the public-join Edge Function, which verifies its CAPTCHA before calling). Client values for '
  'priority, status, org or ticket are never accepted. Blank name, phone, email, locale or device '
  'key count as not given; party size defaults to 1. The phone and email are kept on the visit '
  'for its own messages and never linked to an existing guest. Raises captcha_required (online '
  'join without a valid pass, or DETAIL public_join: any caller but a kiosk or the service role while deployment_settings.anon_join_enabled is false), queue_not_accepting '
  '(paused, closed or outside hours; the reason is the DETAIL), org_suspended (the org is not '
  'active), capacity_reached, rate_limited (DETAIL client: this phone on this network; network: '
  'this network; queue: everyone, for a minute; queue_total: the queue''s online joins for the '
  'hour; device: this kiosk), not_found (unknown queue or '
  'service, or a kiosk of another location), invalid_input (bad name, phone, email, party size, '
  'locale or device key, or no key). p_answers (intake answers, 2A-Q5), p_group_key (join as '
  'a group, 2A-J15A) and p_onsite_code (the code on the display, 2A-JN5) are accepted and '
  'ignored until those tickets land; later they add party_size_out_of_range, invalid_answers, '
  'onsite_code_required, onsite_code_invalid, captcha_failed and too_many_active_visits. Later '
  'phases append parameters with defaults; never add join_* variants. Implemented in V1 (#30), '
  'device key in #474, join pass for Turnstile.';
