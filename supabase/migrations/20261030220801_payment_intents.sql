-- 3-PAY3 (#364): what the payment-intent and payment-jobs Edge Functions need from the database.
-- begin_payment resolves a guest token to the payment the policy asks for and records it BEFORE the
-- provider is called, so a crash between the two can't orphan a provider intent: a retry finds the
-- same row and reuses its id as the provider idempotency key. (Alternative rejected: one RPC that
-- records after the provider call, which loses the link on a crash.) Both functions are service role
-- only: the Edge Function is the only caller and holds the rate limit and the provider keys.

create function api.begin_payment(p_token text, p_provider text, p_idempotency_key text)
returns table (payment_id uuid, org_id uuid, kind text, amount_minor bigint, currency text, ref_id uuid, intent_id text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_hash bytea := private.token_hash(coalesce(p_token, ''));
  v app.visits;
  a app.appointments;
  pol app.payment_policies;
  v_org uuid;
  v_loc uuid;
  v_service uuid;
  v_starts timestamptz;
  v_kind text;
  p app.payments;
begin
  if p_token is null or length(p_token) not between 8 and 200
     or length(coalesce(p_provider, '')) not between 1 and 30
     or length(coalesce(p_idempotency_key, '')) not between 1 and 200 then
    raise exception 'invalid_input';
  end if;
  select * into a from app.appointments x where x.guest_token_hash = v_hash;
  if found then
    v_org := a.org_id; v_loc := a.location_id; v_service := a.service_id; v_starts := a.starts_at;
  else
    select * into v from app.visits x where x.guest_token_hash = v_hash;
    if not found then raise exception 'not_found'; end if;
    v_org := v.org_id; v_loc := v.location_id; v_service := v.service_id;
  end if;
  select * into pol from app.payment_policies x where x.org_id = v_org and x.service_id = v_service;
  if not found or pol.mode = 'none' then raise exception 'payment_not_required'; end if;

  -- A card authorisation lasts about 7 days: hold only within 6, otherwise save the card.
  v_kind := case when pol.mode = 'deposit' then 'deposit'
                 when v_starts is null or v_starts < now() + interval '6 days' then 'hold'
                 else 'card_on_file' end;

  -- Serialize concurrent calls for one visit or appointment, so two tabs can't open two intents.
  perform pg_advisory_xact_lock(hashtextextended(coalesce(a.id, v.id)::text, 0));
  select * into p from app.payments x
  where x.org_id = v_org and x.kind = v_kind and x.status in ('requires_action', 'authorized', 'succeeded')
    and ((a.id is not null and x.appointment_id = a.id) or (a.id is null and x.visit_id = v.id))
  order by x.created_at limit 1;
  if not found then
    insert into app.payments (org_id, location_id, visit_id, appointment_id, provider, kind, amount_minor, currency,
                              release_after, cancel_cutoff_hours, idempotency_key)
    values (v_org, v_loc, case when a.id is null then v.id end, a.id, p_provider, v_kind, pol.amount_minor, pol.currency,
            pol.release_after, pol.cancel_cutoff_hours, p_idempotency_key)
    on conflict on constraint payments_org_id_idempotency_key_key do nothing
    returning * into p;
    if p.id is null then
      -- The key was used before. It must have been for this same visit or appointment, never another's.
      select * into p from app.payments x
      where x.org_id = v_org and x.idempotency_key = p_idempotency_key
        and ((a.id is not null and x.appointment_id = a.id) or (a.id is null and x.visit_id = v.id));
      if p.id is null then raise exception 'invalid_input'; end if;
    end if;
  end if;
  return query select p.id, p.org_id, p.kind, p.amount_minor, p.currency, coalesce(a.id, v.id), p.intent_id;
end $$;
comment on function api.begin_payment(text, text, text) is
  'Service role only (payment-intent): resolves a visit or appointment link token to the payment its '
  'service policy requires (hold when the appointment is within 6 days, card_on_file when further out, '
  'deposit for deposit policies) and records it, status requires_action. The amount and currency come from '
  'the policy only. Repeating for the same visit or appointment returns the same payment. Raises '
  'not_found (unknown token), payment_not_required, invalid_input.';

create function api.attach_payment_intent(p_payment_id uuid, p_intent_id text, p_setup_intent_id text)
returns void
language sql volatile security definer set search_path = '' as $$
  update app.payments set intent_id = coalesce(intent_id, nullif(p_intent_id, '')),
         setup_intent_id = coalesce(setup_intent_id, nullif(p_setup_intent_id, '')), updated_at = now()
  where id = p_payment_id
$$;
comment on function api.attach_payment_intent(uuid, text, text) is
  'Service role only (payment-intent): stores the provider intent ids on a payment; the first value wins.';

revoke all on function api.begin_payment(text, text, text), api.attach_payment_intent(uuid, text, text)
  from public, anon, authenticated;
grant execute on function api.begin_payment(text, text, text), api.attach_payment_intent(uuid, text, text) to service_role;

------------------------------------------------------------------------------------------------
-- Kicking payment-jobs
------------------------------------------------------------------------------------------------

create function private.kick_payment_jobs() returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_url text;
  v_key text;
begin
  if current_setting('app.payment_jobs_kicked', true) = 'on' then return; end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'payment_jobs_url';
  if v_url is null then return; end if;
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'dispatcher_key';
  perform net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || coalesce(v_key, '')));
  perform set_config('app.payment_jobs_kicked', 'on', true);
exception when others then
  raise warning 'kick_payment_jobs failed: %', sqlerrm;
end $$;
comment on function private.kick_payment_jobs() is
  'Asks pg_net to POST to the payment-jobs function after commit (vault secret payment_jobs_url). Never raises.';

create function private.kick_on_payment_job() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.kick_payment_jobs();
  return null;
end $$;
create trigger kick_payment_jobs after insert on app.payment_jobs
  for each statement execute function private.kick_on_payment_job();

create function ops.kick_payment_jobs_if_due() returns void
language sql volatile security definer set search_path = '' as $$
  select private.kick_payment_jobs() where exists (
    select 1 from app.payment_jobs j
    where j.next_attempt_at <= now() and (j.status = 'queued' or (j.status = 'claimed' and j.locked_until < now())))
$$;
select cron.schedule('kick-payment-jobs', '* * * * *', 'select ops.kick_payment_jobs_if_due()');

revoke all on function private.kick_payment_jobs(), private.kick_on_payment_job(), ops.kick_payment_jobs_if_due()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
