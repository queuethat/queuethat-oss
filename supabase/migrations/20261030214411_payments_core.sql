-- 3-PAY2 (#363): payment policies, payments and the jobs that capture, release and refund them.
-- Provider calls happen outside the transaction: state changes enqueue payment_jobs that the
-- payment-jobs Edge Function claims with a lease (3-PAY3). Payments are never deleted. Clients only
-- read; every write is a definer function or a service-role call. The phase-0 payment_holds and
-- payment_events stay for the dev webhook loop until 3-PAY4 (#365) moves it onto app.payments.

create table app.payment_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  -- Derived from the service by a trigger, so a policy can't claim another location's scope.
  location_id uuid not null,
  service_id uuid not null,
  mode text not null default 'none' check (mode in ('none', 'deposit', 'hold')),
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  release_after text not null default 'served' check (release_after in ('served', 'checked_in')),
  cancel_cutoff_hours int not null default 24 check (cancel_cutoff_hours between 0 and 720),
  updated_at timestamptz not null default now(),
  check (mode = 'none' or amount_minor > 0),
  foreign key (org_id, location_id) references app.locations (org_id, id),
  foreign key (org_id, service_id) references app.services (org_id, id),
  unique (org_id, service_id)
);

create function private.payment_policy_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select s.location_id into new.location_id from app.services s
  where s.org_id = new.org_id and s.id = new.service_id;
  if new.location_id is null then raise exception 'not_found'; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger payment_policy_scope before insert or update on app.payment_policies
  for each row execute function private.payment_policy_scope();
create trigger forbid_org_change before update on app.payment_policies
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.payment_policies
  for each row execute function private.audit_row();

create table app.payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  visit_id uuid,
  appointment_id uuid,
  provider text not null check (length(provider) between 1 and 30),
  intent_id text check (length(intent_id) between 1 and 200),
  setup_intent_id text check (length(setup_intent_id) between 1 and 200),
  customer_id text check (length(customer_id) between 1 and 200),
  payment_method_id text check (length(payment_method_id) between 1 and 200),
  kind text not null check (kind in ('hold', 'deposit', 'card_on_file', 'no_show_fee')),
  status text not null default 'requires_action'
    check (status in ('requires_action', 'authorized', 'succeeded', 'captured', 'released', 'refunded', 'failed')),
  amount_minor bigint not null check (amount_minor >= 0),
  refunded_minor bigint not null default 0 check (refunded_minor between 0 and amount_minor),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  -- The policy as it was when the guest paid, so later edits don't change what they agreed to.
  release_after text not null default 'served' check (release_after in ('served', 'checked_in')),
  cancel_cutoff_hours int not null default 24 check (cancel_cutoff_hours between 0 and 720),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visit_id is null or appointment_id is null),
  foreign key (org_id, location_id) references app.locations (org_id, id),
  foreign key (org_id, visit_id) references app.visits (org_id, id),
  foreign key (org_id, appointment_id) references app.appointments (org_id, id),
  unique (org_id, id),
  unique (org_id, idempotency_key),
  unique (provider, intent_id)
);
create index payments_visit_idx on app.payments (visit_id) where visit_id is not null;
create index payments_appointment_idx on app.payments (appointment_id) where appointment_id is not null;
create trigger forbid_org_change before update on app.payments
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.payments
  for each row execute function private.audit_row();

create table app.payment_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  payment_id uuid not null,
  action text not null check (action in ('capture', 'release', 'refund', 'charge_no_show')),
  amount_minor bigint check (amount_minor is null or amount_minor > 0),
  status text not null default 'queued' check (status in ('queued', 'claimed', 'done', 'failed', 'dead')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  -- Provider error code only: never card or customer data.
  last_error text check (length(last_error) <= 100),
  dedupe_key text not null unique check (length(dedupe_key) between 1 and 200),
  created_at timestamptz not null default now(),
  foreign key (org_id, payment_id) references app.payments (org_id, id),
  foreign key (org_id, location_id) references app.locations (org_id, id)
);
create index payment_jobs_due_idx on app.payment_jobs (next_attempt_at) where status in ('queued', 'claimed');

alter table app.payment_policies enable row level security;
alter table app.payments enable row level security;
alter table app.payment_jobs enable row level security;
revoke all on app.payment_policies, app.payments, app.payment_jobs from anon, authenticated;
grant select on app.payments, app.payment_jobs to authenticated;
grant select, insert, update, delete on app.payment_policies to authenticated;
grant all on app.payment_policies, app.payments, app.payment_jobs to service_role;
revoke delete on app.payments, app.payment_jobs from service_role;

create policy payments_select on app.payments for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));
create policy payment_jobs_select on app.payment_jobs for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));
create policy payment_policies_select on app.payment_policies for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));
create policy payment_policies_insert on app.payment_policies for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy payment_policies_update on app.payment_policies for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy payment_policies_delete on app.payment_policies for delete to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')));

------------------------------------------------------------------------------------------------
-- Releasing holds
------------------------------------------------------------------------------------------------

create function private.enqueue_payment_release(p_payment_id uuid) returns void
language sql volatile security definer set search_path = '' as $$
  insert into app.payment_jobs (org_id, location_id, payment_id, action, dedupe_key)
  select p.org_id, p.location_id, p.id, 'release', 'release:' || p.id
  from app.payments p
  where p.id = p_payment_id and p.kind = 'hold' and p.status = 'authorized'
    and not exists (select 1 from app.payment_jobs j where j.payment_id = p.id and j.action = 'charge_no_show')
  on conflict (dedupe_key) do nothing
$$;
comment on function private.enqueue_payment_release(uuid) is
  'Queues one release job for an authorized hold; repeats (dedupe_key) are no-ops.';

-- A cancellation is timely when it comes at least cancel_cutoff_hours before the appointment.
create function private.payment_cancel_is_timely(p_payment app.payments) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select now() <= a.starts_at - make_interval(hours => p_payment.cancel_cutoff_hours)
     from app.appointments a where a.org_id = p_payment.org_id and a.id = p_payment.appointment_id),
    true)
$$;

create function private.release_payments_on_visit_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  p app.payments;
begin
  for p in
    select * from app.payments pay
    where pay.org_id = new.org_id and pay.kind = 'hold' and pay.status = 'authorized'
      and (pay.visit_id = new.visit_id
           or pay.appointment_id in (select a.id from app.appointments a
                                     where a.org_id = new.org_id and a.visit_id = new.visit_id))
  loop
    if new.to_status = 'served'
       or (p.release_after = 'checked_in' and new.to_status in ('waiting', 'called', 'serving'))
       or (new.to_status in ('cancelled', 'removed') and private.payment_cancel_is_timely(p)) then
      perform private.enqueue_payment_release(p.id);
    end if;
  end loop;
  return null;
end $$;
create trigger release_payments after insert on app.visit_events
  for each row execute function private.release_payments_on_visit_event();

create function private.release_payments_on_appointment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  p app.payments;
begin
  for p in
    select * from app.payments pay
    where pay.org_id = new.org_id and pay.appointment_id = new.id
      and pay.kind = 'hold' and pay.status = 'authorized'
  loop
    if private.payment_cancel_is_timely(p) then perform private.enqueue_payment_release(p.id); end if;
  end loop;
  return null;
end $$;
create trigger release_payments after update of status on app.appointments
  for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function private.release_payments_on_appointment();

------------------------------------------------------------------------------------------------
-- Staff RPCs
------------------------------------------------------------------------------------------------

create function private.payment_row(p app.payments) returns api.payment_row
language sql immutable set search_path = '' as $$
  select (p.id, p.visit_id, p.appointment_id, p.provider, p.kind, p.status, p.amount_minor,
          p.currency, p.updated_at)::api.payment_row
$$;

-- Finds the payment for a manager of its location. Staff below manager are denied; anyone with no
-- role at the location (another tenant) gets not_found, so ids don't leak.
create function private.payment_for_manager(p_payment_id uuid) returns app.payments
language plpgsql stable security definer set search_path = '' as $$
declare
  p app.payments;
begin
  select * into p from app.payments where id = p_payment_id;
  if not found or not private.has_role(p.org_id, p.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_role(p.org_id, p.location_id, 'manager') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  return p;
end $$;

-- redefines api.staff_charge_no_show from 20261030210404_api_contracts_3.sql
create or replace function api.staff_charge_no_show(p_payment_id uuid, p_idempotency_key uuid) returns api.payment_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  p app.payments;
  claim record;
  v_no_show boolean;
begin
  if p_idempotency_key is null then raise exception 'invalid_input'; end if;
  p := private.payment_for_manager(p_payment_id);
  select * into claim from private.claim_idempotent(p.org_id, 'staff_charge_no_show', p_idempotency_key);
  if claim.replay then
    if (claim.response ->> 'id')::uuid is distinct from p.id then raise exception 'invalid_input'; end if;
    return jsonb_populate_record(null::api.payment_row, claim.response);
  end if;
  select coalesce(
           (select v.status = 'no_show' from app.visits v where v.org_id = p.org_id and v.id = p.visit_id),
           (select a.status = 'no_show' or v.status = 'no_show'
            from app.appointments a left join app.visits v on v.org_id = a.org_id and v.id = a.visit_id
            where a.org_id = p.org_id and a.id = p.appointment_id),
           false)
    into v_no_show;
  if not v_no_show or p.kind not in ('hold', 'card_on_file') or p.status <> 'authorized' or p.amount_minor <= 0
     or exists (select 1 from app.payment_jobs j where j.payment_id = p.id and j.action = 'release') then
    raise exception 'illegal_payment_action';
  end if;
  insert into app.payment_jobs (org_id, location_id, payment_id, action, amount_minor, dedupe_key)
  values (p.org_id, p.location_id, p.id, 'charge_no_show', p.amount_minor, 'charge:' || p.id)
  on conflict (dedupe_key) do nothing;
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, after)
  values (p.org_id, (select auth.uid()),
          (select m.role::text from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = p.org_id),
          'UPDATE', 'payments', p.id::text, jsonb_build_object('event', 'charge_no_show', 'amount_minor', p.amount_minor));
  perform private.save_idempotent('staff_charge_no_show', p_idempotency_key, to_jsonb(private.payment_row(p)));
  return private.payment_row(p);
end $$;
comment on function api.staff_charge_no_show(uuid, uuid) is
  'Queues the no-show fee on a held or stored card (the job runner captures or charges it). Manager '
  'or above of the payment''s location. Raises not_found (also for another tenant), permission_denied, '
  'illegal_payment_action (visit is not a no-show, or the payment is not an authorized hold or saved '
  'card), invalid_input. Idempotent per key and per payment. Implemented by 3-PAY2 (#363).';

-- redefines api.staff_refund_payment from 20261030210404_api_contracts_3.sql
create or replace function api.staff_refund_payment(p_payment_id uuid, p_amount_minor bigint, p_reason text, p_idempotency_key uuid) returns api.payment_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  p app.payments;
  claim record;
  v_amount bigint;
  v_left bigint;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_idempotency_key is null or length(coalesce(v_reason, '')) > 200
     or (p_amount_minor is not null and p_amount_minor <= 0) then
    raise exception 'invalid_input';
  end if;
  p := private.payment_for_manager(p_payment_id);
  select * into claim from private.claim_idempotent(p.org_id, 'staff_refund_payment', p_idempotency_key);
  if claim.replay then
    if (claim.response ->> 'id')::uuid is distinct from p.id then raise exception 'invalid_input'; end if;
    return jsonb_populate_record(null::api.payment_row, claim.response);
  end if;
  -- Serialize refunds of one payment, and count refunds already queued but not yet reported.
  select * into p from app.payments where id = p.id for update;
  v_left := p.amount_minor - p.refunded_minor - coalesce(
    (select sum(j.amount_minor) from app.payment_jobs j
     where j.payment_id = p.id and j.action = 'refund' and j.status in ('queued', 'claimed')), 0);
  v_amount := coalesce(p_amount_minor, v_left);
  if p.status not in ('succeeded', 'captured') or v_amount <= 0 or v_amount > v_left then
    raise exception 'illegal_payment_action';
  end if;
  insert into app.payment_jobs (org_id, location_id, payment_id, action, amount_minor, dedupe_key)
  values (p.org_id, p.location_id, p.id, 'refund', v_amount, 'refund:' || p.id || ':' || p_idempotency_key)
  on conflict (dedupe_key) do nothing;
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, after)
  values (p.org_id, (select auth.uid()),
          (select m.role::text from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = p.org_id),
          'UPDATE', 'payments', p.id::text, jsonb_build_object('event', 'refund', 'amount_minor', v_amount, 'reason', v_reason));
  perform private.save_idempotent('staff_refund_payment', p_idempotency_key, to_jsonb(private.payment_row(p)));
  return private.payment_row(p);
end $$;
comment on function api.staff_refund_payment(uuid, bigint, text, uuid) is
  'Queues a full (null amount) or partial refund of a succeeded or captured payment. Manager or above '
  'of the payment''s location. Raises not_found (also for another tenant), permission_denied, '
  'invalid_input, illegal_payment_action (not refundable, or more than is left). Idempotent per key. '
  'Implemented by 3-PAY2 (#363).';

------------------------------------------------------------------------------------------------
-- Job runner (service role)
------------------------------------------------------------------------------------------------

-- redefines api.claim_payment_jobs from 20261030210404_api_contracts_3.sql
create or replace function api.claim_payment_jobs(p_limit int, p_lease_seconds int) returns setof api.payment_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_limit not between 1 and 100 or p_lease_seconds not between 5 and 3600 then
    raise exception 'invalid_input';
  end if;
  update app.payment_jobs set status = 'dead', locked_until = null, last_error = 'lease_expired'
  where status = 'claimed' and locked_until < now() and attempts >= 6;
  return query
  with due as (
    select j.id from app.payment_jobs j
    where j.next_attempt_at <= now()
      and (j.status = 'queued' or (j.status = 'claimed' and j.locked_until < now()))
    order by j.next_attempt_at, j.created_at
    limit p_limit
    for update skip locked
  )
  update app.payment_jobs j
  set status = 'claimed', attempts = j.attempts + 1,
      locked_until = now() + make_interval(secs => p_lease_seconds)
  from due
  where j.id = due.id
  returning j.id, j.org_id, j.payment_id, j.action, j.amount_minor, j.attempts;
end $$;
comment on function api.claim_payment_jobs(int, int) is
  'Service role only (payment-jobs runner): leases up to p_limit due jobs, oldest first, counting '
  'the attempt; a lease that expired unreported is claimable again. Two concurrent callers never get '
  'the same job; a lease that expires on a sixth attempt dead-letters the job. The runner must use the '
  'job id as the provider idempotency key. Raises invalid_input. Implemented by 3-PAY2 (#363).';

-- p_result: {"ok": true, "status": "captured|released|refunded|...", "intent_id": "..."} or
-- {"ok": false, "retryable": bool, "code": "..."}. Dead after 6 attempts.
-- redefines api.report_payment_result from 20261030210404_api_contracts_3.sql
create or replace function api.report_payment_result(p_job_id uuid, p_result jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  j app.payment_jobs;
begin
  select * into j from app.payment_jobs where id = p_job_id for update;
  if not found then raise exception 'not_found'; end if;
  if j.status <> 'claimed' then return; end if; -- a repeat, or the lease was lost: no-op
  if coalesce((p_result ->> 'ok')::boolean, false) then
    update app.payment_jobs set status = 'done', locked_until = null, last_error = null where id = j.id;
    -- Each action applies only to a payment in a state it fits, so a late or odd outcome never
    -- moves money state backwards or sideways.
    if j.action = 'refund' then
      update app.payments p
      set refunded_minor = p.refunded_minor + j.amount_minor,
          status = case when p.refunded_minor + j.amount_minor >= p.amount_minor then 'refunded' else p.status end,
          updated_at = now()
      where p.id = j.payment_id and p.status in ('succeeded', 'captured')
        and p.refunded_minor + j.amount_minor <= p.amount_minor;
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
  'retryable, code}) and moves the payment along. Retryable failures back off 30 s x 2^attempts and '
  'go dead after 6 attempts; other failures are failed at once. Reporting a job that is not claimed '
  'is a no-op. Raises not_found. Implemented by 3-PAY2 (#363).';

revoke all on function private.enqueue_payment_release(uuid), private.payment_cancel_is_timely(app.payments),
  private.release_payments_on_visit_event(), private.release_payments_on_appointment(),
  private.payment_row(app.payments), private.payment_for_manager(uuid), private.payment_policy_scope()
  from public, anon, authenticated;
