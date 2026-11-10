-- Paid bookings need a connected card processor, and bulk blocks release unpaid holds.
-- "Connected" is what the DB can see: the org's payments provider_settings row is enabled (owner-enabled
-- through api.set_channel_enabled, which needs verified credentials). The payment-intent function reads
-- the provider from its own environment, so this is the org-level switch, not a live health check.
--   * a policy cannot be switched on (insert, or mode none -> hold/deposit) while no processor is connected;
--   * if it disconnects later, new guest bookings are no longer held pending (no card can be taken), and
--     pending ones are confirmed by the sweep instead of expiring on a guest who could not pay;
--   * api.block_time_bulk cancels pending holds in the blocked range (reason 'blocked'), which frees the seat.
-- redefines private.require_card_on_booking from 20261031033440_require_card_for_paid_bookings.sql
-- redefines ops.expire_unpaid_appointments from 20261031033440_require_card_for_paid_bookings.sql
-- redefines api.block_time_bulk from 20261030165833_bulk_blocks.sql

create function private.payments_connected(p_org_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.provider_settings s where s.org_id = p_org_id and s.channel = 'payments' and s.enabled)
$$;
comment on function private.payments_connected(uuid) is
  'True when the org has an enabled payments provider (owner-enabled, credentials verified when enabled). A database switch, not a live health check.';
revoke all on function private.payments_connected(uuid) from public, anon, authenticated;

create function private.require_processor_for_policy() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode <> 'none' and (tg_op = 'INSERT' or old.mode = 'none') and not private.payments_connected(new.org_id) then
    raise exception 'payments_not_connected';
  end if;
  return new;
end $$;
comment on function private.require_processor_for_policy() is
  'Refuses to switch a payment policy on while the org has no enabled payments provider (payments_not_connected).';
create trigger require_processor before insert or update of mode on app.payment_policies
  for each row execute function private.require_processor_for_policy();
revoke all on function private.require_processor_for_policy() from public, anon, authenticated;

create or replace function private.require_card_on_booking() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pol app.payment_policies;
begin
  -- Only the moments a guest booking is born: a new row, or a waitlist offer being claimed.
  if new.status::text = 'booked' and new.source = 'guest' and new.event_id is null and new.guest_token_hash is not null
     and (tg_op = 'INSERT' or old.status::text = 'offered') then
    select * into pol from app.payment_policies x
    where x.org_id = new.org_id and x.service_id = new.service_id and x.mode <> 'none'
      and private.payments_connected(x.org_id);
    if found then
      -- The cap below needs a contact to count against.
      if new.guest_phone_e164 is null and new.guest_email is null then raise exception 'invalid_input'; end if;
      -- Unpaid bookings hold slots, so one contact cannot hold more than 3 at once.
      if (select count(*) from app.appointments a
          where a.org_id = new.org_id and a.payment_due_at is not null and a.id <> new.id
            and ((new.guest_phone_e164 is not null and a.guest_phone_e164 = new.guest_phone_e164)
                 or (new.guest_email is not null and a.guest_email = new.guest_email))) >= 3 then
        raise exception 'rate_limited' using detail = 'client';
      end if;
      new.status := 'pending_payment';
    end if;
  end if;
  new.payment_due_at := case when new.status::text <> 'pending_payment' then null
                             when tg_op = 'UPDATE' and old.payment_due_at is not null then old.payment_due_at
                             else now() + make_interval(mins => coalesce(pol.pay_within_minutes, 15)) end;
  return new;
end $$;

create or replace function ops.expire_unpaid_appointments() returns int
language plpgsql volatile set search_path = '' as $$
declare
  a app.appointments;
  n int := 0;
begin
  perform private.set_actor('system', null, 'payment_expired');
  for a in select x.* from app.appointments x where x.payment_due_at <= now() order by x.payment_due_at limit 200 loop
    perform private.lock_location(a.location_id);
    select x.* into a from app.appointments x
    where x.id = a.id and x.payment_due_at <= now() and x.status::text = 'pending_payment' for update;
    if a.id is null then continue; end if;
    if exists (select 1 from app.payments p where p.appointment_id = a.id and p.status in ('authorized', 'succeeded', 'captured'))
       or not exists (select 1 from app.payment_policies x where x.org_id = a.org_id and x.service_id = a.service_id and x.mode <> 'none')
       or not private.payments_connected(a.org_id) then
      -- Paid after all (the webhook raced us), or the policy was switched off or the processor disconnected while the guest was deciding.
      update app.appointments set status = 'booked' where id = a.id;
    else
      update app.appointments set status = 'cancelled', cancelled_reason = 'payment_expired' where id = a.id returning * into a;
      perform private.release_capacity(a); -- the next waitlisted guest is offered it
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function api.block_time_bulk(p_location_id uuid, p_resource_ids uuid[], p_ranges tstzrange[], p_reason text, p_idempotency_key uuid)
returns api.bulk_block_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  claim record;
  res api.bulk_block_result;
  v_resources uuid[];
  pend app.appointments;
begin
  select l.org_id into v_org from app.locations l where l.id = p_location_id;
  if v_org is null then raise exception 'not_found'; end if;
  if not private.has_role(v_org, p_location_id, 'manager') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_idempotency_key is null or length(coalesce(v_reason, '')) > 200
     or coalesce(cardinality(p_resource_ids), 0) not between 1 and 50
     or coalesce(cardinality(p_ranges), 0) not between 1 and 50
     or exists (select 1 from unnest(p_ranges) r
                where r is null or isempty(r) or lower_inf(r) or upper_inf(r)) then
    raise exception 'invalid_input';
  end if;

  v_resources := (select array_agg(distinct x) from unnest(p_resource_ids) x);
  if (select count(*) from app.counters c
      where c.id = any (v_resources) and c.org_id = v_org and c.location_id = p_location_id)
     <> cardinality(v_resources) then
    raise exception 'invalid_resource';
  end if;

  -- Before the block is written, so a pending hold cannot be confirmed between the conflict list and the cancels.
  perform private.lock_location(p_location_id);
  select * into claim from private.claim_idempotent(v_org, 'block_time_bulk', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.bulk_block_result, claim.response);
  end if;

  with ins as (
    insert into app.time_blocks (org_id, location_id, counter_id, during, reason, created_by)
    select v_org, p_location_id, c, r, v_reason, (select auth.uid())
    from unnest(v_resources) c cross join unnest(p_ranges) r
    returning id
  )
  select coalesce(array_agg(id), '{}') into res.block_ids from ins;

  -- A booking conflicts when it overlaps a range and needs the blocked resource: the resource is
  -- that staff member's own, or the booking's service is mapped to it.
  select coalesce(array_agg(distinct a.id), '{}') into res.conflicts
  from app.appointments a
  cross join unnest(v_resources) c
  join app.counters ctr on ctr.id = c
  cross join unnest(p_ranges) r
  where a.location_id = p_location_id
    and a.status in ('booked', 'checked_in')
    and tstzrange(a.starts_at, a.ends_at) && r
    and (a.staff_user_id = ctr.member_user_id
         or exists (select 1 from app.service_resources sr
                    where sr.service_id = a.service_id and sr.counter_id = c));

  -- An unpaid pending booking in the blocked time is released rather than left to confirm into it.
  perform private.set_actor('staff', (select auth.uid()), 'block_time', 'blocked');
  for pend in
    select a2.* from app.appointments a2
    where a2.id in (
      select a3.id from app.appointments a3
      cross join unnest(v_resources) c
      join app.counters ctr on ctr.id = c
      cross join unnest(p_ranges) r
      where a3.location_id = p_location_id and a3.payment_due_at is not null
        and tstzrange(a3.starts_at, a3.ends_at) && r
        and (a3.staff_user_id = ctr.member_user_id
             or exists (select 1 from app.service_resources sr where sr.service_id = a3.service_id and sr.counter_id = c)))
    for update
  loop
    update app.appointments set status = 'cancelled', cancelled_reason = 'blocked' where id = pend.id returning * into pend;
    perform private.release_capacity(pend);
  end loop;

  perform private.save_idempotent('block_time_bulk', p_idempotency_key, to_jsonb(res));
  return res;
end $$;

comment on function api.block_time_bulk(uuid, uuid[], tstzrange[], text, uuid) is
  'Blocks every resource over every range in one transaction (max 50 x 50, bounded ranges). '
  'Returns the created block ids and the ids of booked or checked-in appointments that overlap '
  'a block and need the resource (own staff resource or mapped service); they stay booked. '
  'Unpaid pending_payment holds in the same range are cancelled (reason blocked) and their seat released. '
  'Manager or above. Raises not_found (location), permission_denied, invalid_input, '
  'invalid_resource (unknown or foreign resource; nothing is created). Idempotent per key.';

notify pgrst, 'reload schema';
