-- 3-EM2 (#348): a hard bounce or spam complaint suppresses the address.
--
-- Why a new service-role function and not the payload's address: the address is derived from the
-- org's own message (the provider id its webhook names), so a forged-but-signed event, or one sent
-- through another org's endpoint, can suppress nothing but that org's own recipients. The sender's
-- suppression list is org-scoped; bounces and complaints also bind every other org (claim_outbox
-- already treats those two reasons as platform-wide).
create function api.suppress_by_message(p_org_id uuid, p_provider text, p_provider_message_id text, p_reason text)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  n app.notifications;
  v_address text;
begin
  if p_reason is null or p_reason not in ('bounce', 'complaint')
     or p_org_id is null or coalesce(p_provider, '') = '' or coalesce(p_provider_message_id, '') = '' then
    raise exception 'invalid_input';
  end if;
  select * into n from app.notifications
  where org_id = p_org_id and provider = p_provider and provider_message_id = p_provider_message_id
  limit 1;
  if not found or n.channel <> 'email' then
    return false;
  end if;
  v_address := private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id);
  if v_address is null then
    return false;
  end if;
  insert into app.suppressions (org_id, channel, value, reason)
  values (n.org_id, n.channel, private.canonical_email(v_address), 'stop')
  on conflict (org_id, channel, value) do nothing;
  return true;
end $$;
comment on function api.suppress_by_message(uuid, text, text, text) is
  'Service role only (provider-webhook): suppresses (for that org only, reason stop) the email address of the org''s own message with that provider id, from the next claim on. Idempotent. Returns false when the org has no such email message (nothing is written). Raises invalid_input. p_reason (bounce or complaint) is validated but not stored: only the org itself is bound.';
revoke all on function api.suppress_by_message(uuid, text, text, text) from public, anon, authenticated;
grant execute on function api.suppress_by_message(uuid, text, text, text) to service_role;
