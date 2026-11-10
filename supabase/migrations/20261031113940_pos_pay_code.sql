-- 4-PAY2 (#992): staff tablet QR to the guest's pay page for a counter payment (#387 follow-up).
-- The guest link token is stored only as a hash (I-7), so the tablet cannot encode /v/<token>.
-- Interface choice, three ways to get a guest from the counter to the card form:
--  (a) a short, staff-minted pay code bound to one open counter payment, redeemed by the existing
--      payment-intent function through a service-only RPC (won);
--  (b) re-deriving the guest's link token on the staff device (rejected: I-7 allows re-derivation
--      only for the device that joined, and a staff-readable token is a full status-page login);
--  (c) keep "open Pay now on your own status page" (today's behavior: no QR, and a guest who
--      joined on another device or lost the page cannot pay).
-- (a) adds one authenticated staff RPC (api.staff_create_pay_code) because staff_request_payment's
-- return type is fixed by #387 and a code is minted and rotated independently of the amount, and
-- one service-only RPC (api.begin_pos_payment_by_code) that mirrors begin_pos_payment. Neither is
-- executable by anon; the guest reaches the second only through the payment-intent function.

create table app.pay_codes (
  -- sha256 of the normalized code. The code itself exists only in the staff RPC's answer.
  code_hash bytea primary key,
  org_id uuid not null,
  payment_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, payment_id) references app.payments (org_id, id) on delete cascade
);
create index pay_codes_payment_idx on app.pay_codes (payment_id);
alter table app.pay_codes enable row level security;
revoke all on app.pay_codes from anon, authenticated;
-- No client policy lets a row through; codes are minted and redeemed in definer functions.
create policy pay_codes_none on app.pay_codes for select to authenticated using (false);

create type api.pay_code as (
  code text,
  expires_at timestamptz
);

-- Upper case, Crockford look-alikes folded (O to 0, I and L to 1), separators dropped.
create function private.pay_code_normalize(p_code text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select translate(upper(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g')), 'OIL', '011')
$$;
revoke all on function private.pay_code_normalize(text) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- Staff: show the code for the open counter payment
------------------------------------------------------------------------------------------------

create function api.staff_create_pay_code(p_visit_id uuid) returns api.pay_code
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  p app.payments;
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes bytea := extensions.gen_random_bytes(8);
  v_code text := '';
  v_expires timestamptz := now() + interval '10 minutes';
begin
  -- Another tenant's visit, and a visit the caller has no role for, look the same: not_found.
  select * into v from app.visits x where x.id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then raise exception 'not_found'; end if;
  if private.write_blocked_reason(v.org_id, 'staff', (select auth.uid())) is not null
     or not private.has_permission(v.org_id, v.location_id, 'payments.request') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v.id::text, 0));
  select * into p from app.payments x
  where x.org_id = v.org_id and x.visit_id = v.id and x.kind = 'pos' and x.status = 'requires_action'
  order by x.created_at desc limit 1;
  if not found then raise exception 'illegal_payment_action'; end if;
  -- 32 symbols, so the low five bits of each byte are uniform. One live code per payment.
  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) & 31) + 1, 1);
  end loop;
  delete from app.pay_codes where payment_id = p.id;
  insert into app.pay_codes (code_hash, org_id, payment_id, expires_at)
  values (extensions.digest(v_code, 'sha256'), p.org_id, p.id, v_expires);
  return row(v_code, v_expires)::api.pay_code;
end $$;
comment on function api.staff_create_pay_code(uuid) is
  'Staff and above: a short code (8 characters, valid 10 minutes) that opens the card form for the visit''s '
  'open counter payment, for the tablet to show as a QR. Asking again replaces the earlier code. The code '
  'opens only that payment: never the status page, a link token or contact data. Raises not_found (unknown '
  'visit or no role at its location), permission_denied (read-only support access, suspended org, or a '
  'custom role without payments.request), illegal_payment_action (no unpaid counter payment requested).';

revoke all on function api.staff_create_pay_code(uuid) from public, anon;
grant execute on function api.staff_create_pay_code(uuid) to authenticated;

------------------------------------------------------------------------------------------------
-- Guest page: the open request behind a code (service role only, called by payment-intent)
------------------------------------------------------------------------------------------------

create function api.begin_pos_payment_by_code(p_code text, p_provider text)
returns table (payment_id uuid, org_id uuid, kind text, amount_minor bigint, currency text, ref_id uuid,
               intent_id text, cancel_cutoff_hours int, release_after text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code text := private.pay_code_normalize(p_code);
  p app.payments;
begin
  if p_code is null or length(p_code) not between 8 and 20 or length(coalesce(p_provider, '')) not between 1 and 30 then
    raise exception 'invalid_input';
  end if;
  -- Unknown, expired, replaced and already-paid codes are one answer, so a code proves nothing about a visit.
  if v_code !~ '^[0-9A-HJKMNP-TV-Z]{8}$' then raise exception 'not_found'; end if;
  select x.* into p from app.pay_codes c
  join app.payments x on x.org_id = c.org_id and x.id = c.payment_id
  where c.code_hash = extensions.digest(v_code, 'sha256') and c.expires_at > now()
    and x.kind = 'pos' and x.status = 'requires_action'
  for update of x;
  if not found then raise exception 'not_found'; end if;
  -- The provider is whichever one the deployment runs; the first guest to open the request fixes it.
  if p.provider = 'pending' then
    update app.payments set provider = p_provider, updated_at = now() where id = p.id returning * into p;
  end if;
  return query select p.id, p.org_id, p.kind, p.amount_minor, p.currency, p.visit_id, p.intent_id,
                      p.cancel_cutoff_hours, p.release_after;
end $$;
comment on function api.begin_pos_payment_by_code(text, text) is
  'Service role only (payment-intent): the unpaid counter payment a staff-minted pay code opens, with the '
  'provider fixed on first use. Never creates a payment. Raises not_found (unknown, expired, replaced or '
  'already-paid code, all alike) and invalid_input.';

revoke all on function api.begin_pos_payment_by_code(text, text) from public, anon, authenticated;
grant execute on function api.begin_pos_payment_by_code(text, text) to service_role;

notify pgrst, 'reload schema';
