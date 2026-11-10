-- 4-INT1 (#395) part 2: the generic integration job queue and the OAuth hand-off that the Square (#395) and
-- HubSpot (#396) adapters share. Nothing here knows a vendor.
--
-- * app.integration_jobs: one job per (enabled pos/crm connection, served visit), retried and dead-lettered like
--   the webhook queue. The job stores no contact data: the guest's contact is resolved at claim time, so a
--   consent withdrawn after the visit still stops the sync (job skipped, no_consent).
-- * Consent default (decision for #398): a guest is synced only when the visit's contact holds a granted,
--   un-revoked MARKETING consent on a matching channel and the address is not suppressed. Transactional
--   consent never covers a CRM.
--
-- Interface rule 7, alternatives: (a) one queue table per vendor, rejected: retries, leases and consent would be
-- written twice; (b) one generic queue keyed by the provider_settings row (chosen). The composite foreign key
-- makes a job for another org's connection impossible at the schema level.

alter table app.provider_settings add constraint provider_settings_org_id_key unique (org_id, id);

create table app.integration_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  setting_id uuid not null,
  visit_id uuid not null,
  event_id text not null,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'delivered', 'failed', 'dead', 'skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  error text,
  created_at timestamptz not null default now(),
  foreign key (org_id, setting_id) references app.provider_settings (org_id, id) on delete cascade,
  foreign key (org_id, visit_id) references app.visits (org_id, id),
  unique (setting_id, event_id)
);
create index integration_jobs_due_idx on app.integration_jobs (next_attempt_at) where status in ('queued', 'failed', 'claimed');
create index integration_jobs_org_idx on app.integration_jobs (org_id, created_at desc);
create trigger forbid_org_change before update on app.integration_jobs
  for each row execute function private.forbid_org_change();
alter table app.integration_jobs enable row level security;
create policy integration_jobs_select on app.integration_jobs for select to authenticated
  using ((select private.is_org_admin_unrestricted(org_id)));
revoke all on app.integration_jobs from public, anon, authenticated;
grant select on app.integration_jobs to authenticated;

------------------------------------------------------------------------------------------------
-- Consent and enqueue
------------------------------------------------------------------------------------------------

create function private.integration_contact(p_org_id uuid, p_visit_id uuid)
returns table (channel text, value text, name text)
language sql stable security definer set search_path = '' as $$
  select gc.channel::text, gc.value, v.guest_name
  from app.visits v
  join app.guest_contacts gc on gc.org_id = v.org_id and gc.id = v.contact_id
  where v.id = p_visit_id and v.org_id = p_org_id and gc.channel in ('phone', 'email')
    and exists (select 1 from app.consents c
                where c.org_id = gc.org_id and c.contact_id = gc.id and c.purpose = 'marketing'
                  and c.status = 'granted' and c.revoked_at is null
                  and c.channel::text = any (case gc.channel when 'phone' then array['sms', 'whatsapp'] else array['email'] end))
    and not exists (select 1 from app.suppressions sp
                    where sp.org_id = gc.org_id and sp.value = gc.value
                      and sp.channel::text = case gc.channel when 'phone' then 'sms' else 'email' end)
$$;
revoke all on function private.integration_contact(uuid, uuid) from public, anon, authenticated;
comment on function private.integration_contact(uuid, uuid) is
  'The visit''s phone or email contact when it holds a granted, un-revoked marketing consent on a matching channel '
  'and is not suppressed; no row otherwise. The one consent rule for every CRM or POS sync.';

create function private.kick_integrations() returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_url text;
  v_key text;
begin
  if current_setting('app.integrations_kicked', true) = 'on' then return; end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'integration_sync_url';
  if v_url is null then return; end if;
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'dispatcher_key';
  perform net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || coalesce(v_key, '')));
  perform set_config('app.integrations_kicked', 'on', true);
exception when others then
  raise warning 'kick_integrations failed: %', sqlerrm;
end $$;
revoke all on function private.kick_integrations() from public, anon, authenticated;
comment on function private.kick_integrations() is
  'Asks pg_net to POST to the integration-sync function after commit (vault secret integration_sync_url). Never raises.';

create function private.enqueue_integration_jobs() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.type = 'complete' and exists (select 1 from private.integration_contact(new.org_id, new.visit_id)) then
    insert into app.integration_jobs (org_id, setting_id, visit_id, event_id)
    select s.org_id, s.id, new.visit_id, 'v:' || new.id
    from app.provider_settings s
    where s.org_id = new.org_id and s.channel in ('pos', 'crm') and s.enabled
    on conflict (setting_id, event_id) do nothing;
    if found then perform private.kick_integrations(); end if;
  end if;
  return null;
end $$;
revoke all on function private.enqueue_integration_jobs() from public, anon, authenticated;
create trigger enqueue_integration_jobs after insert on app.visit_events
  for each row execute function private.enqueue_integration_jobs();

------------------------------------------------------------------------------------------------
-- Queue RPCs (service role)
------------------------------------------------------------------------------------------------

create type api.integration_job as (
  id uuid, org_id uuid, channel text, provider text, kind text, config jsonb, secrets jsonb, attempts int,
  visit jsonb, contact jsonb
);

create function api.claim_integration_jobs(p_limit int, p_lease_seconds int) returns setof api.integration_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 100 or p_lease_seconds is null or p_lease_seconds not between 1 and 600 then
    raise exception 'invalid_input';
  end if;
  update app.integration_jobs set status = 'dead', error = 'lease_expired', locked_until = null
  where status = 'claimed' and locked_until < now() and attempts + 1 >= 6;
  -- consent is re-checked at claim time: a withdrawal after the visit stops the sync
  update app.integration_jobs j set status = 'skipped', error = 'no_consent', locked_until = null
  where ((j.status in ('queued', 'failed') and j.next_attempt_at <= now()) or (j.status = 'claimed' and j.locked_until < now()))
    and not exists (select 1 from private.integration_contact(j.org_id, j.visit_id));
  return query
  with due as (
    select j.id from app.integration_jobs j join app.provider_settings s on s.id = j.setting_id
    where s.enabled and ((j.status in ('queued', 'failed') and j.next_attempt_at <= now())
                         or (j.status = 'claimed' and j.locked_until < now()))
    order by j.next_attempt_at limit p_limit for update of j skip locked
  ), claimed as (
    update app.integration_jobs j
    set status = 'claimed', locked_until = now() + make_interval(secs => p_lease_seconds),
        attempts = j.attempts + case when j.status = 'claimed' then 1 else 0 end
    from due where j.id = due.id returning j.*
  )
  select c.id, c.org_id, s.channel, s.provider, 'visit_served', s.config,
         (select coalesce(jsonb_object_agg(x.key, d.decrypted_secret), '{}')
          from jsonb_each(s.secret_ids) x join vault.decrypted_secrets d on d.id = (x.value #>> '{}')::uuid),
         c.attempts,
         jsonb_build_object('id', v.id, 'ticket', v.display_ticket, 'queue', q.name, 'joined_at', v.joined_at,
                            'serving_at', v.serving_at, 'finished_at', v.finished_at),
         (select to_jsonb(k) from private.integration_contact(c.org_id, c.visit_id) k)
  from claimed c
  join app.provider_settings s on s.id = c.setting_id
  join app.visits v on v.id = c.visit_id
  join app.queues q on q.id = v.queue_id;
end $$;
comment on function api.claim_integration_jobs(int, int) is
  'Service role only: leases up to p_limit due jobs of enabled pos or crm connections for p_lease_seconds with the '
  'decrypted credentials, the served visit and the consenting contact {channel, value, name}. A job whose guest no '
  'longer has a granted marketing consent is skipped (no_consent), never returned. Concurrent workers never receive '
  'the same row. Secrets must stay in function memory for one invocation.';

create function api.report_integration_result(p_job_id uuid, p_result jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  j app.integration_jobs;
  ok boolean := p_result ->> 'status' = 'delivered';
  retryable boolean := coalesce((p_result ->> 'retryable')::boolean, true);
begin
  select * into j from app.integration_jobs where id = p_job_id for update;
  if not found then raise exception 'not_found'; end if;
  -- a stale worker (lease expired and re-claimed, or already settled) changes nothing
  if j.status <> 'claimed' then return; end if;
  update app.integration_jobs
  set status = case when ok then 'delivered' when not retryable or j.attempts + 1 >= 6 then 'dead' else 'failed' end,
      attempts = j.attempts + 1, locked_until = null,
      next_attempt_at = now() + make_interval(mins => least(power(3, j.attempts)::int, 240)),
      error = left(p_result ->> 'error', 200)
  where id = j.id;
end $$;
comment on function api.report_integration_result(uuid, jsonb) is
  'Service role only: records an attempt {status: delivered|failed, retryable, error}. error is a short code, never '
  'a response body. Failures back off (1, 3, 9 ... up to 240 minutes) and the sixth becomes dead.';

revoke all on function api.claim_integration_jobs(int, int), api.report_integration_result(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function api.claim_integration_jobs(int, int), api.report_integration_result(uuid, jsonb) to service_role;

create function ops.purge_integration_jobs() returns int
language sql volatile security definer set search_path = '' as $$
  with d as (delete from app.integration_jobs where created_at < now() - interval '30 days' returning 1)
  select count(*)::int from d
$$;
revoke all on function ops.purge_integration_jobs() from public, anon, authenticated;
select cron.schedule('purge-integration-jobs', '31 3 * * *', 'select ops.purge_integration_jobs()');

create function ops.kick_integrations_if_due() returns void
language sql volatile security definer set search_path = '' as $$
  select private.kick_integrations() where exists (
    select 1 from app.integration_jobs j where j.status in ('queued', 'failed') and j.next_attempt_at <= now())
$$;
revoke all on function ops.kick_integrations_if_due() from public, anon, authenticated;
select cron.schedule('kick-integrations', '* * * * *', 'select ops.kick_integrations_if_due()');

notify pgrst, 'reload schema';
