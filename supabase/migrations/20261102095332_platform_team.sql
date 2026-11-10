-- Platform team (#1134, part of #1128): who holds a platform role, and the way to take one away.
--
-- Granting stays CLI-only (technical-design.md 3.6): nothing here inserts or updates
-- app.platform_roles. Two functions:
--   api.platform_team()        operator + aal2, read-only list for /platform/team
--   api.platform_revoke_role() service role only, called by `pnpm platform:revoke`
-- The revoke is a function (not a REST delete) because auth.sessions is not reachable through
-- the API, and the "never remove the last operator" check must be atomic with the delete.

create function api.platform_team()
returns table (
  user_id uuid,
  email text,
  role app.platform_role,
  mfa_enrolled boolean,
  last_sign_in_at timestamptz,
  granted_by uuid,
  granted_by_email text,
  granted_at timestamptz,
  is_you boolean
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('operator');
  return query
    select r.user_id,
           u.email::text,
           r.role,
           exists (select 1 from auth.mfa_factors f
                   where f.user_id = r.user_id and f.factor_type = 'totp' and f.status = 'verified'),
           u.last_sign_in_at,
           r.granted_by,
           g.email::text,
           r.granted_at,
           r.user_id = (select auth.uid())
    from app.platform_roles r
    join auth.users u on u.id = r.user_id
    left join auth.users g on g.id = r.granted_by
    order by r.role desc, u.email, r.user_id;
end $$;
comment on function api.platform_team() is
  'Operator with aal2: everyone holding a platform role, operators first. Per member: email, '
  'role, whether a verified authenticator app is enrolled, last sign-in (null if never), who '
  'granted the role (granted_by is null when it was granted with the command line) and when, and '
  'is_you for the caller''s own row. Read-only: no function grants or changes a platform role. '
  'Raises permission_denied (42501) without operator and aal2.';

revoke all on function api.platform_team() from public, anon;
grant execute on function api.platform_team() to authenticated;

create function api.platform_revoke_role(p_user_id uuid, p_allow_last_operator boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role app.platform_role;
  v_sessions int;
begin
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'not_found';
  end if;

  -- Serialises with other revokes, so two operators cannot each remove the other.
  perform 1 from app.platform_roles where role = 'operator' for update;

  select r.role into v_role from app.platform_roles r where r.user_id = p_user_id;
  if v_role = 'operator' and not coalesce(p_allow_last_operator, false)
     and not exists (select 1 from app.platform_roles r
                     where r.role = 'operator' and r.user_id <> p_user_id) then
    raise exception 'last_operator';
  end if;

  -- The audit trigger records the revoke. Sessions end even when there was no role, so a run
  -- that stopped half way can be repeated; a token they hold would keep its claims otherwise.
  delete from app.platform_roles where user_id = p_user_id;
  delete from auth.sessions where user_id = p_user_id;
  get diagnostics v_sessions = row_count;

  return jsonb_build_object('revoked', v_role is not null, 'previous_role', v_role,
                            'sessions', v_sessions);
end $$;
comment on function api.platform_revoke_role(uuid, boolean) is
  'Service role only (pnpm platform:revoke); no API role can execute it. Removes the user''s '
  'platform role (audited by the table trigger) and deletes all their sessions, which also '
  'removes their refresh tokens. Returns {revoked, previous_role, sessions}. Repeating it is a '
  'no-op that reports revoked false (it still ends any sessions). Raises not_found for an '
  'unknown user and last_operator when this would remove the only operator, unless '
  'p_allow_last_operator.';

revoke all on function api.platform_revoke_role(uuid, boolean) from public, anon, authenticated;
grant execute on function api.platform_revoke_role(uuid, boolean) to service_role;
