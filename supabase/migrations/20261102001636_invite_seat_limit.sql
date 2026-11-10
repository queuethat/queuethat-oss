-- #1081: check the staff seat limit when inviting, not when the invitee accepts.
-- Before, create_invitation never looked at limit.members, so the limit only tripped on the
-- membership insert at acceptance: the inviter saw success and the invitee saw an error.
-- A seat is a membership or a pending invitation to a different address. Re-inviting an address that
-- already has a pending invitation replaces it (resend), so it never needs a second seat.
-- The signature is unchanged. api.accept_invitation is not redefined: its membership insert still
-- hits the plan_limit trigger, which is the backstop when the org filled up meanwhile; only its
-- comment now names that error.

-- redefines api.create_invitation from 20261030061824_invitations.sql
create or replace function api.create_invitation(p_org_id uuid, p_email text, p_role text, p_location_ids uuid[], p_display_name text, p_idempotency_key uuid)
returns api.invitation_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role app.member_role;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_limit int;
  claim record;
  token text;
  inv app.invitations;
begin
  begin
    v_role := p_role::app.member_role;
  exception when others then
    raise exception 'invalid_input';
  end;
  perform private.require_people_manager(p_org_id, v_role);
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 or length(coalesce(v_name, 'x')) > 80
     or p_idempotency_key is null
     or (p_location_ids is not null and (cardinality(p_location_ids) = 0 or exists (
           select 1 from unnest(p_location_ids) l
           where not exists (select 1 from app.locations x where x.id = l and x.org_id = p_org_id)))) then
    raise exception 'invalid_input';
  end if;

  select * into claim from private.claim_idempotent(p_org_id, 'create_invitation', p_idempotency_key);
  if claim.replay then
    -- Only the hash is stored, so a replay cannot return the token again.
    return jsonb_populate_record(null::api.invitation_row, claim.response);
  end if;

  if exists (select 1 from app.memberships m join auth.users u on u.id = m.user_id
             where m.org_id = p_org_id and lower(u.email::text) = v_email) then
    raise exception 'invalid_input';
  end if;
  if (select count(*) from app.invitations i where i.org_id = p_org_id
      and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()) >= 100 then
    raise exception 'rate_limited';
  end if;

  -- Seats: members plus pending invitations to other addresses must stay under the plan limit. The
  -- same advisory lock as private.enforce_plan_limit, so two concurrent invites cannot both pass.
  v_limit := nullif(private.entitlement(p_org_id, 'limit.members') #>> '{}', '')::int;
  if v_limit is not null and v_limit >= 0 then
    perform pg_advisory_xact_lock(hashtextextended('plan_limit:' || p_org_id || 'limit.members', 0));
    if (select count(*) from app.memberships m where m.org_id = p_org_id)
       + (select count(*) from app.invitations i where i.org_id = p_org_id and i.email <> v_email
          and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()) >= v_limit then
      -- the limit rides along as the error detail so the screen can say what the plan includes
      raise exception 'plan_limit_reached' using detail = v_limit::text;
    end if;
  end if;

  -- A new invite replaces any pending one for the same address (this is also "resend").
  update app.invitations set revoked_at = now()
  where org_id = p_org_id and email = v_email and accepted_at is null and revoked_at is null;

  token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=' || chr(10), '-_');
  begin
    insert into app.invitations (org_id, email, role, location_ids, display_name, token_hash, invited_by)
    values (p_org_id, v_email, v_role, p_location_ids, v_name, private.token_hash(token), (select auth.uid()))
    returning * into inv;
  exception when unique_violation then
    raise exception 'rate_limited'; -- a concurrent invite for this address won; try again
  end;
  perform private.save_idempotent('create_invitation', p_idempotency_key, to_jsonb(private.invitation_row(inv)));
  return private.invitation_row(inv, token);
end $$;
comment on function api.create_invitation(uuid, text, text, uuid[], text, uuid) is
  'Invites an email to the org with a role and locations. Owners may invite any role, admins '
  'manager and staff only. Returns the plaintext token once; only its sha256 is stored, so an '
  'idempotent replay returns the invitation without it. A new invite replaces the pending one for '
  'the same address. Raises forbidden_role, permission_denied, invalid_input (bad email, location '
  'or an address that is already a member), not_found (not a member), rate_limited, and '
  'plan_limit_reached (members plus pending invitations to other addresses have reached the '
  'plan''s limit.members; the error detail is the limit; inviting an address that already has a '
  'pending invitation never raises it). Implemented by 2A-TM1.';

comment on function api.accept_invitation(text) is
  'Accepts the invitation for the signed-in user whose email matches the invited one and returns '
  'the new membership. Repeating it for the same user returns the same membership. Raises not_found '
  'for an unknown, expired or revoked token or another user''s email, not_authenticated, and '
  'plan_limit_reached when the org filled its seats since the invite was sent (the invitation stays '
  'pending, so accepting works once a seat frees up or the plan changes). Implemented by 2A-TM1.';
