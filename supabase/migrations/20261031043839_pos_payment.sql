-- 4-PAY1 (#387): take payment at the counter. Staff ask for an amount on a visit and the guest pays
-- from their status page with the same Payment Element as the booking card step. Interface choice:
-- (a) a new staff RPC plus a service-only "peek" for the guest's page, (b) stretching begin_payment
-- (which must keep its #364 signature and decides by policy). (a) won: begin_payment stays as it is.

alter table app.payments drop constraint payments_kind_check;
alter table app.payments add constraint payments_kind_check
  check (kind in ('hold', 'deposit', 'card_on_file', 'no_show_fee', 'pos'));

------------------------------------------------------------------------------------------------
-- Staff: request a payment
------------------------------------------------------------------------------------------------

insert into private.permission_catalogue (permission, min_role, grantable, description) values
  ('payments.request', 'staff', true, 'Ask a guest to pay an amount at the counter');

create function api.staff_request_payment(
  p_visit_id uuid, p_amount_minor bigint, p_currency text, p_idempotency_key uuid
) returns api.payment_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  p app.payments;
  claim record;
  v_row api.payment_row;
begin
  if p_idempotency_key is null or p_amount_minor is null or p_amount_minor not between 1 and 10000000
     or p_currency is null or p_currency !~ '^[a-z]{3}$' then
    raise exception 'invalid_input';
  end if;
  -- Another tenant's visit, and a visit the caller has no role for, look the same: not_found.
  select * into v from app.visits x where x.id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then raise exception 'not_found'; end if;
  -- has_role admits read-only support grants and suspended orgs; this write must not.
  if private.write_blocked_reason(v.org_id, 'staff', (select auth.uid())) is not null
     or not private.has_permission(v.org_id, v.location_id, 'payments.request') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not private.payments_connected(v.org_id) then raise exception 'illegal_payment_action'; end if;
  select * into claim from private.claim_idempotent(v.org_id, 'staff_request_payment', p_idempotency_key);
  if claim.replay then
    if (claim.response ->> 'visit_id')::uuid is distinct from v.id then raise exception 'invalid_input'; end if;
    return jsonb_populate_record(null::api.payment_row, claim.response);
  end if;
  if v.status not in ('called', 'serving', 'served') then raise exception 'illegal_payment_action'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v.id::text, 0));
  select * into p from app.payments x
  where x.org_id = v.org_id and x.visit_id = v.id and x.kind = 'pos' and x.status = 'requires_action'
  for update;
  if found then
    -- A mistyped amount is corrected until the guest's page opens the request (begin_pos_payment fixes the
    -- provider then, before any Stripe intent exists); after that it is refunded instead
    -- (staff_refund_payment) and never replaced under an intent that is already being created.
    if p.provider <> 'pending' then raise exception 'illegal_payment_action'; end if;
    update app.payments set amount_minor = p_amount_minor, currency = p_currency, updated_at = now()
    where id = p.id returning * into p;
  else
    insert into app.payments (org_id, location_id, visit_id, provider, kind, amount_minor, currency, idempotency_key)
    values (v.org_id, v.location_id, v.id, 'pending', 'pos', p_amount_minor, p_currency, p_idempotency_key::text)
    returning * into p;
  end if;
  v_row := private.payment_row(p);
  perform private.save_idempotent('staff_request_payment', p_idempotency_key, to_jsonb(v_row));
  return v_row;
end $$;
comment on function api.staff_request_payment(uuid, bigint, text, uuid) is
  'Staff and above: asks the guest of a called, serving or served visit to pay p_amount_minor (1 to 10,000,000 '
  'minor units, lower-case ISO currency) from their status page. Repeating the key returns the first answer; a '
  'new request replaces an unpaid one the guest has not opened yet. Raises not_found (unknown visit or no role '
  'at its location), permission_denied (read-only support access, suspended org, or a custom role without '
  'payments.request), invalid_input, illegal_payment_action (no payment processor connected, visit not called, '
  'serving or served, or the guest''s page already opened an earlier request).';

revoke all on function api.staff_request_payment(uuid, bigint, text, uuid) from public, anon;
grant execute on function api.staff_request_payment(uuid, bigint, text, uuid) to authenticated;

------------------------------------------------------------------------------------------------
-- Guest page: the open request, if any (service role only, called by payment-intent)
------------------------------------------------------------------------------------------------

create function api.begin_pos_payment(p_token text, p_provider text)
returns table (payment_id uuid, org_id uuid, kind text, amount_minor bigint, currency text, ref_id uuid,
               intent_id text, cancel_cutoff_hours int, release_after text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  p app.payments;
begin
  if p_token is null or length(p_token) not between 8 and 200 or length(coalesce(p_provider, '')) not between 1 and 30 then
    raise exception 'invalid_input';
  end if;
  select * into v from app.visits x where x.guest_token_hash = private.token_hash(p_token);
  if not found then raise exception 'not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v.id::text, 0));
  select * into p from app.payments x
  where x.org_id = v.org_id and x.visit_id = v.id and x.kind = 'pos' and x.status = 'requires_action'
  order by x.created_at desc limit 1 for update;
  if not found then raise exception 'payment_not_required'; end if;
  -- The provider is whichever one the deployment runs; the first guest to open the request fixes it.
  if p.provider = 'pending' then
    update app.payments set provider = p_provider, updated_at = now() where id = p.id returning * into p;
  end if;
  return query select p.id, p.org_id, p.kind, p.amount_minor, p.currency, v.id, p.intent_id,
                      p.cancel_cutoff_hours, p.release_after;
end $$;
comment on function api.begin_pos_payment(text, text) is
  'Service role only (payment-intent): the unpaid counter payment staff requested for the visit behind a guest '
  'link token, with the provider fixed on first use. Never creates a payment. Raises not_found (unknown token), '
  'payment_not_required (nothing requested), invalid_input.';

revoke all on function api.begin_pos_payment(text, text) from public, anon, authenticated;
grant execute on function api.begin_pos_payment(text, text) to service_role;

------------------------------------------------------------------------------------------------
-- Receipt
------------------------------------------------------------------------------------------------

-- redefines the trigger check from 20261031040553_sms_credits.sql
alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary',
                     'credit_low', 'receipt'));
insert into app.notification_templates (trigger, channel, category, subject, body) values
  ('receipt', 'email', 'transactional', 'Your receipt from {org}',
   'Thank you. {org} received your payment of {amount}.'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]');

-- The receipt goes to a verified email contact only, never to an address typed into the join form:
-- a typed address is a recipient anyone could aim at someone else. The dispatcher still applies
-- consent and suppression.
create function private.enqueue_pos_receipt() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
begin
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version,
                                 category, vars, dedupe_key)
  select new.org_id, v.id, 'email', gc.id, 'receipt', t.version, t.category,
         jsonb_build_object('org', o.name,
                            'amount', to_char(new.amount_minor / 100.0, 'FM999,999,990.00') || ' ' || upper(new.currency)),
         'receipt:' || new.id
  from app.visits v
  join app.guest_contacts gc on gc.id = v.contact_id and gc.org_id = v.org_id and gc.channel = 'email'
    and gc.verified_at is not null
  join app.organizations o on o.id = v.org_id
  cross join lateral private.resolve_template(v.org_id, null, 'receipt', 'email', v.locale) t
  where v.id = new.visit_id and v.org_id = new.org_id
  on conflict (dedupe_key) do nothing;
  return null;
end $$;
create trigger enqueue_pos_receipt after update of status on app.payments
  for each row when (new.kind = 'pos' and new.status = 'succeeded' and old.status is distinct from 'succeeded')
  execute function private.enqueue_pos_receipt();
revoke all on function private.enqueue_pos_receipt() from public, anon, authenticated;

notify pgrst, 'reload schema';
