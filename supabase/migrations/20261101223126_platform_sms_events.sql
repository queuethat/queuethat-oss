-- Platform Twilio, part 2 (#1089): events from the platform-owned number have no org in their route, so one
-- service-role function applies them. A delivery report is applied to the org that owns the message; a
-- STOP or START is a sender-level opt-out (Twilio's Advanced Opt-Out blocks the number for the whole
-- Messaging Service), so it suppresses or restores the number in every org that sends through the platform.

-- A stop given to the shared number gets its own reason, so a START lifts only that and never an
-- org's unsubscribe link or keyword stop.
alter table app.suppressions drop constraint suppressions_reason_check;
alter table app.suppressions add constraint suppressions_reason_check
  check (reason in ('stop', 'bounce', 'complaint', 'manual', 'platform_stop'));

create function api.apply_platform_sms_event(p_kind text, p_phone text default null, p_provider_message_id text default null,
                                             p_status text default null, p_error_code text default null) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  if p_kind = 'status' then
    if coalesce(p_provider_message_id, '') = '' or coalesce(p_status, '') = '' then raise exception 'invalid_input'; end if;
    -- only a message sent through a platform-mode org can be reported on this route
    select n.org_id into v_org from app.notifications n
    join app.provider_settings s on s.org_id = n.org_id and s.channel = 'sms' and s.mode = 'platform'
    where n.provider = 'twilio' and n.provider_message_id = left(p_provider_message_id, 200) and n.channel = 'sms'
    limit 1;
    if v_org is null then return false; end if;
    return api.apply_delivery_status(v_org, 'twilio', p_provider_message_id, p_status, p_error_code);
  elsif p_kind in ('stop', 'start') then
    if p_phone is null or p_phone !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'invalid_input'; end if;
    if p_kind = 'stop' then
      insert into app.suppressions (org_id, channel, value, reason)
      select s.org_id, 'sms', p_phone, 'platform_stop' from app.provider_settings s
      where s.channel = 'sms' and s.mode = 'platform'
      on conflict (org_id, channel, value) do nothing;
    else
      -- only a stop given to this sender; an org's own stop, a bounce, complaint or manual block stays
      delete from app.suppressions x using app.provider_settings s
      where x.org_id = s.org_id and s.channel = 'sms' and s.mode = 'platform'
        and x.channel = 'sms' and x.value = p_phone and x.reason = 'platform_stop';
    end if;
    return true;
  end if;
  raise exception 'invalid_input';
end $$;
revoke all on function api.apply_platform_sms_event(text, text, text, text, text) from public, anon, authenticated;
grant execute on function api.apply_platform_sms_event(text, text, text, text, text) to service_role;
comment on function api.apply_platform_sms_event(text, text, text, text, text) is
  'Service role only (provider-webhook, platform Twilio number). kind status: applies a delivery report (p_status, p_error_code) '
  'to the platform-mode org that owns p_provider_message_id; false when none does. kind stop or start: records a sender-level opt-out '
  'of p_phone (E.164) in every platform-mode SMS org, or lifts a stop (never a bounce, complaint or manual block). Raises invalid_input.';

notify pgrst, 'reload schema';
