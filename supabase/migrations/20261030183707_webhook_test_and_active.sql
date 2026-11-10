-- 2B-I8 (#313): the webhooks admin UI needs two owner/admin actions: send a test event and switch an
-- endpoint on or off. app.webhook_endpoints takes no client writes, so both go through RPCs.
-- (No Phase-0 stub existed; both are siblings of rotate_webhook_secret, not a new surface.)

create function api.send_webhook_test(p_endpoint_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  e app.webhook_endpoints;
  v_id text;
begin
  select * into e from app.webhook_endpoints where id = p_endpoint_id for update;
  if not found or not exists (select 1 from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = e.org_id) then
    raise exception 'not_found';
  end if;
  if not private.is_org_admin_unrestricted(e.org_id) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not e.active then raise exception 'invalid_input'; end if;
  -- a repeat within 10 seconds is the same test, not another one
  if exists (select 1 from app.webhook_deliveries d where d.endpoint_id = e.id and d.event_type = 'ping'
             and d.created_at > now() - interval '10 seconds') then
    return;
  end if;
  v_id := 'ping:' || gen_random_uuid();
  insert into app.webhook_deliveries (org_id, endpoint_id, event_id, event_type, payload)
  values (e.org_id, e.id, v_id, 'ping',
          jsonb_build_object('id', v_id, 'type', 'ping', 'api_version', 'v1', 'occurred_at', now(),
                             'data', jsonb_build_object('message', 'Test event from your queue')));
  perform private.kick_webhooks();
end $$;
comment on function api.send_webhook_test(uuid) is
  'Queues one ping event to the endpoint so its owner can check the receiver; a repeat within 10 seconds '
  'is a no-op. Owner or admin. Raises not_found, permission_denied, invalid_input (endpoint is off).';

create function api.set_webhook_active(p_endpoint_id uuid, p_active boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  e app.webhook_endpoints;
begin
  select * into e from app.webhook_endpoints where id = p_endpoint_id for update;
  if not found or not exists (select 1 from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = e.org_id) then
    raise exception 'not_found';
  end if;
  if not private.is_org_admin_unrestricted(e.org_id) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_active is null then raise exception 'invalid_input'; end if;
  update app.webhook_endpoints
  set active = p_active,
      consecutive_failures = case when p_active then 0 else consecutive_failures end,
      disabled_reason = case when p_active then null else coalesce(disabled_reason, 'manual') end
  where id = e.id;
  if p_active then perform private.kick_webhooks(); end if;
end $$;
comment on function api.set_webhook_active(uuid, boolean) is
  'Turns an endpoint on or off. Turning it on clears its failure count and disabled_reason (an endpoint '
  'switched off after too many failures can be revived). Owner or admin. Raises not_found, permission_denied.';

revoke all on function api.send_webhook_test(uuid), api.set_webhook_active(uuid, boolean) from public, anon;
grant execute on function api.send_webhook_test(uuid), api.set_webhook_active(uuid, boolean) to authenticated, service_role;
notify pgrst, 'reload schema';
