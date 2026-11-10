-- 3-PAY4 (#365): Stripe is the source of truth for payment outcomes. The provider-webhook function
-- has already verified the signature and de-duplicated the event id; this applies one event to
-- app.payments in a monotonic order, so late, repeated or reordered events never move a payment back.

create function api.apply_payment_event(
  p_org_id uuid, p_provider text, p_type text, p_object_id text, p_meta_org uuid,
  p_amount_minor bigint, p_customer_id text, p_payment_method_id text
) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  p app.payments;
  v_new text;
  v_rank constant jsonb := '{"requires_action":0,"failed":0,"authorized":1,"succeeded":2,"captured":2,"released":3,"refunded":3}';
begin
  if p_type not in ('authorized', 'succeeded', 'canceled', 'failed', 'setup_succeeded', 'refunded') then
    raise exception 'invalid_input';
  end if;
  -- The endpoint's org is the authority; metadata written at creation must agree with it.
  if p_meta_org is not null and p_meta_org <> p_org_id then return 'org_mismatch'; end if;

  select * into p from app.payments x
  where x.org_id = p_org_id and x.provider = p_provider
    and (x.intent_id = p_object_id or (p_type = 'setup_succeeded' and x.setup_intent_id = p_object_id))
  for update;
  if not found then return 'unknown_intent'; end if;

  if p_type = 'setup_succeeded' then
    update app.payments set customer_id = coalesce(customer_id, p_customer_id),
           payment_method_id = coalesce(payment_method_id, p_payment_method_id),
           status = case when status = 'requires_action' then 'authorized' else status end, updated_at = now()
    where id = p.id;
    return 'applied';
  elsif p_type = 'refunded' then
    if p.status not in ('succeeded', 'captured', 'refunded') then return 'ignored'; end if;
    update app.payments set refunded_minor = least(amount_minor, greatest(refunded_minor, coalesce(p_amount_minor, 0))),
           status = case when greatest(refunded_minor, coalesce(p_amount_minor, 0)) >= amount_minor then 'refunded' else status end,
           updated_at = now()
    where id = p.id;
    return 'applied';
  end if;

  v_new := case p_type
    when 'authorized' then 'authorized'
    when 'succeeded' then case when p.kind = 'hold' then 'captured' else 'succeeded' end
    when 'canceled' then 'released'
    else 'failed' end;
  -- A hold is only captured after it was authorized, and only an unpaid payment can be released.
  if (v_new = 'captured' and p.status <> 'authorized')
     or (v_new = 'released' and p.status not in ('requires_action', 'authorized')) then
    return 'ignored';
  end if;
  -- Forward only. A failed attempt can still be retried by the guest, so only a payment that has not
  -- progressed at all can fail.
  if (v_rank ->> v_new)::int > (v_rank ->> p.status)::int
     or (v_new = 'failed' and p.status = 'requires_action') then
    update app.payments set status = v_new, updated_at = now() where id = p.id;
    return 'applied';
  end if;
  return 'ignored';
end $$;
comment on function api.apply_payment_event(uuid, text, text, text, uuid, bigint, text, text) is
  'Service role only (provider-webhook, after the signature check and event-id de-duplication): applies '
  'one Stripe outcome (authorized, succeeded, canceled, failed, setup_succeeded, refunded) to the payment '
  'of that provider intent in the endpoint''s org. Forward-only, so replays and reordering are no-ops. '
  'Returns applied, ignored, unknown_intent (logged by the caller) or org_mismatch (metadata org differs '
  'from the endpoint org: nothing written). Raises invalid_input.';

revoke all on function api.apply_payment_event(uuid, text, text, text, uuid, bigint, text, text)
  from public, anon, authenticated;
grant execute on function api.apply_payment_event(uuid, text, text, text, uuid, bigint, text, text) to service_role;

-- redefines api.report_payment_result from 20261030214411_payments_core.sql
-- The refund branch records the sum of finished refund jobs with greatest(), the same absolute
-- rule apply_payment_event uses, so a refund counted by both the job and charge.refunded counts once.
create or replace function api.report_payment_result(p_job_id uuid, p_result jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  j app.payment_jobs;
  v_refunded bigint;
begin
  select * into j from app.payment_jobs where id = p_job_id for update;
  if not found then raise exception 'not_found'; end if;
  if j.status <> 'claimed' then return; end if; -- a repeat, or the lease was lost: no-op
  if coalesce((p_result ->> 'ok')::boolean, false) then
    update app.payment_jobs set status = 'done', locked_until = null, last_error = null where id = j.id;
    -- Each action applies only to a payment in a state it fits, so a late or odd outcome never
    -- moves money state backwards or sideways.
    if j.action = 'refund' then
      select coalesce(sum(x.amount_minor), 0) into v_refunded from app.payment_jobs x
      where x.payment_id = j.payment_id and x.action = 'refund' and x.status = 'done';
      update app.payments p
      set refunded_minor = least(p.amount_minor, greatest(p.refunded_minor, v_refunded)),
          status = case when greatest(p.refunded_minor, v_refunded) >= p.amount_minor then 'refunded' else p.status end,
          updated_at = now()
      where p.id = j.payment_id and p.status in ('succeeded', 'captured', 'refunded');
    else
      update app.payments p
      set status = case j.action when 'release' then 'released' else 'captured' end,
          intent_id = coalesce(p.intent_id, nullif(p_result ->> 'intent_id', '')),
          updated_at = now()
      where p.id = j.payment_id and p.status = 'authorized';
    end if;
  elsif coalesce((p_result ->> 'retryable')::boolean, false) and j.attempts < 6 then
    update app.payment_jobs
    set status = 'queued', locked_until = null, last_error = left(p_result ->> 'code', 100),
        next_attempt_at = now() + make_interval(secs => 30 * power(2, j.attempts))
    where id = j.id;
  else
    update app.payment_jobs
    set status = case when coalesce((p_result ->> 'retryable')::boolean, false) then 'dead' else 'failed' end,
        locked_until = null, last_error = left(p_result ->> 'code', 100)
    where id = j.id;
  end if;
end $$;
comment on function api.report_payment_result(uuid, jsonb) is
  'Service role only: records a claimed job''s outcome ({ok, status, intent_id} or {ok:false, '
  'retryable, code}) and moves the payment along. Refunds record the sum of finished refund jobs, never '
  'less than what charge.refunded already reported. Retryable failures back off 30 s x 2^attempts and '
  'go dead after 6 attempts; other failures are failed at once. Reporting a job that is not claimed '
  'is a no-op. Raises not_found. Implemented by 3-PAY2 (#363).';

notify pgrst, 'reload schema';
