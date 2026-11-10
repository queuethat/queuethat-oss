-- 2A-TM1 (#95): staff invitations. Replaces the bodies of api.create_invitation, accept_invitation
-- and revoke_invitation (signatures from 20261030045508_api_contracts_2a.sql are unchanged).
--
-- Invites are auth emails, not guest messages: the invite-staff Edge Function sends them through
-- Supabase Auth. The token follows the guest-token rules: random, stored as sha256 only, single
-- use, expiring. Emails are stored lower-cased text rather than citext: with search_path = ''
-- the citext operators are not visible, and lower() gives the same comparison.

alter table app.memberships
  add column id uuid not null default gen_random_uuid(),
  add column display_name text check (display_name is null or length(btrim(display_name)) between 1 and 80);
alter table app.memberships add constraint memberships_id_key unique (id);

create table app.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  role app.member_role not null,
  -- null = every location in the org
  location_ids uuid[],
  display_name text check (display_name is null or length(btrim(display_name)) between 1 and 80),
  token_hash bytea not null unique,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz
);
create index invitations_org_idx on app.invitations (org_id, created_at desc);
-- One pending invitation per address; a concurrent second create fails rather than leaving two live tokens.
create unique index invitations_pending_idx on app.invitations (org_id, email) where accepted_at is null and revoked_at is null;
create trigger forbid_org_change before update on app.invitations
  for each row execute function private.forbid_org_change();

-- Written only by the RPCs below. Not audited by private.audit_row: its before/after rows would
-- copy token_hash into the log.
revoke insert, update, delete, truncate on app.invitations from authenticated;
alter table app.invitations enable row level security;
create policy invitations_select on app.invitations for select to authenticated
  using ((select private.has_role(org_id, null, 'admin')));

------------------------------------------------------------------------------------------------
-- Helpers (2A-TM2 and 2A-TM4 reuse them). Not definers: only the definer RPCs below call them.
------------------------------------------------------------------------------------------------

/** The caller's own role in the org, or null. Support grants do not count: they never manage people. */
create function private.caller_role(p_org_id uuid) returns app.member_role
language sql stable set search_path = '' as $$
  select m.role from app.memberships m
  where m.org_id = p_org_id and m.user_id = (select auth.uid())
$$;
comment on function private.caller_role(uuid) is
  'The signed-in caller''s membership role in the org, or null for a non-member. The one place '
  'team-management RPCs read the acting role.';
revoke all on function private.caller_role(uuid) from public, anon, authenticated;

/**
 * Whether a caller with p_actor may grant or manage p_target: owners any role, admins manager and
 * staff only, everyone else nothing. The role ladder lives here once.
 */
create function private.can_manage_role(p_actor app.member_role, p_target app.member_role) returns boolean
language sql immutable set search_path = '' as $$
  select p_actor = 'owner' or (p_actor = 'admin' and p_target <= 'manager')
$$;
revoke all on function private.can_manage_role(app.member_role, app.member_role) from public, anon, authenticated;

create function private.membership_row(p_membership app.memberships) returns api.membership_row
language sql stable set search_path = '' as $$
  select p_membership.id, p_membership.org_id, p_membership.user_id,
         (select u.email::text from auth.users u where u.id = p_membership.user_id),
         p_membership.display_name, p_membership.role::text, p_membership.location_ids,
         false, p_membership.created_at, null::timestamptz
$$;
revoke all on function private.membership_row(app.memberships) from public, anon, authenticated;

create function private.invitation_row(p_invitation app.invitations, p_token text default null)
returns api.invitation_row
language sql immutable set search_path = '' as $$
  select p_invitation.id, p_invitation.org_id, p_invitation.email, p_invitation.role::text,
         p_invitation.location_ids, p_invitation.display_name, p_invitation.expires_at,
         p_invitation.accepted_at, p_invitation.revoked_at, p_token
$$;
revoke all on function private.invitation_row(app.invitations, text) from public, anon, authenticated;

/** Raises unless the caller manages people in the org and may manage p_target; returns the caller's role. */
create function private.require_people_manager(p_org_id uuid, p_target app.member_role)
returns app.member_role
language plpgsql stable set search_path = '' as $$
declare actor app.member_role := private.caller_role(p_org_id);
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if actor is null then raise exception 'not_found'; end if;
  if actor < 'admin' then raise exception 'permission_denied' using errcode = '42501'; end if;
  if not private.can_manage_role(actor, p_target) then raise exception 'forbidden_role'; end if;
  if exists (select 1 from app.organizations o where o.id = p_org_id and o.status <> 'active') then
    raise exception 'org_suspended';
  end if;
  return actor;
end $$;
revoke all on function private.require_people_manager(uuid, app.member_role) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- RPCs
------------------------------------------------------------------------------------------------

-- redefines api.create_invitation from 20261030045508_api_contracts_2a.sql
create or replace function api.create_invitation(p_org_id uuid, p_email text, p_role text, p_location_ids uuid[], p_display_name text, p_idempotency_key uuid)
returns api.invitation_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role app.member_role;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := nullif(btrim(coalesce(p_display_name, '')), '');
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
  'or an address that is already a member), not_found (not a member), rate_limited. Implemented by 2A-TM1.';

-- redefines api.accept_invitation from 20261030045508_api_contracts_2a.sql
create or replace function api.accept_invitation(p_token text)
returns api.membership_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  mail text;
  inv app.invitations;
  mem app.memberships;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select lower(u.email::text) into mail from auth.users u where u.id = uid;
  select * into inv from app.invitations i where i.token_hash = private.token_hash(coalesce(p_token, '')) for update;
  -- One answer for every way a token can fail, so it reveals nothing about the invitation.
  if not found or inv.email is distinct from mail or inv.revoked_at is not null
     or (inv.accepted_at is not null and inv.accepted_by is distinct from uid)
     or (inv.accepted_at is null and inv.expires_at <= now())
     or not exists (select 1 from app.organizations o where o.id = inv.org_id and o.status = 'active') then
    raise exception 'not_found';
  end if;
  if inv.accepted_at is null then
    update app.invitations set accepted_at = now(), accepted_by = uid where id = inv.id;
    insert into app.memberships (org_id, user_id, role, location_ids, display_name)
    values (inv.org_id, uid, inv.role, inv.location_ids, inv.display_name)
    on conflict (org_id, user_id) do nothing;
  end if;
  select * into mem from app.memberships m where m.org_id = inv.org_id and m.user_id = uid;
  if not found then raise exception 'not_found'; end if;
  return private.membership_row(mem);
end $$;
comment on function api.accept_invitation(text) is
  'Accepts the invitation for the signed-in user whose email matches the invited one and returns '
  'the new membership. Repeating it for the same user returns the same membership. Raises not_found '
  'for an unknown, expired or revoked token or another user''s email, and not_authenticated. '
  'Implemented by 2A-TM1.';

-- redefines api.revoke_invitation from 20261030045508_api_contracts_2a.sql
create or replace function api.revoke_invitation(p_invitation_id uuid, p_idempotency_key uuid)
returns api.invitation_row
language plpgsql volatile security definer set search_path = '' as $$
declare inv app.invitations;
begin
  select * into inv from app.invitations where id = p_invitation_id;
  if not found or private.caller_role(inv.org_id) is null then raise exception 'not_found'; end if;
  perform private.require_people_manager(inv.org_id, inv.role);
  if inv.accepted_at is null and inv.revoked_at is null then
    update app.invitations set revoked_at = now() where id = inv.id returning * into inv;
  end if;
  return private.invitation_row(inv);
end $$;
comment on function api.revoke_invitation(uuid, uuid) is
  'Revokes an unaccepted invitation. Owners, and admins for manager and staff invitations. Revoking '
  'again changes nothing (so the key needs no bookkeeping). Raises not_found for unknown or foreign '
  'ids, forbidden_role, permission_denied. Implemented by 2A-TM1.';
