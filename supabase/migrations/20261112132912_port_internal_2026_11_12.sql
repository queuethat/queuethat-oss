-- Port of the tenant changes made in queuethat-internal on 2026-11-12, one migration for the batch.
-- Each section below is the internal migration named in its header, unchanged: every function it
-- redefines had the same body here as in internal, so the bodies apply as they are. Hosted-only
-- migrations from the same day (operator console, billing, shared-sender ledgers) are not part of it.
-- The hosted service already has these changes from the original migrations; its composed build
-- replaces this file with a placeholder.

-- ==================================================================== from 20261112065731_appointment_provider_name.sql

-- M7 (#1294): a guest's appointment page names the person it is with.
--
-- Booking per provider already works through existing parts: a provider line (queues.kind 'provider', M4)
-- has its own services, each with its own booking policy, capacity and availability rules, so two providers
-- fill the same slot independently, and a rule naming the provider makes them the assigned staff. What the
-- guest could not see was whose appointment it is: api.appointment_status carried only service and location.
--
-- Alternatives (rule 7): a new anon read for the appointment's line (rejected: a second guest entry point and
-- a second token lookup for one text field) vs a trailing attribute on api.appointment_status (chosen). The
-- type is not a phase-0 contract and PostgREST returns it as JSON keyed by name, so old bundles ignore it.
--
-- provider_name is the line's name as the business typed it, and only for a provider line: the same text
-- api.get_location_lines already shows anyone. Never a staff member's account name, never contact data (I-13).
-- A pool ("Anyone available") or general line gives null, so the page says nothing it can't stand behind.

alter type api.appointment_status add attribute provider_name text;

-- redefines private.appointment_status_of from 20261031033440_require_card_for_paid_bookings.sql
create or replace function private.appointment_status_of(p_a app.appointments) returns api.appointment_status
language sql stable set search_path = '' as $$
  select row(p_a.starts_at, p_a.ends_at, p_a.status::text, s.name, l.name, l.slug,
             p_a.event_id is null and p_a.status = 'booked'
               and p_a.starts_at - now() >= make_interval(mins => coalesce(bp.min_notice_minutes, 0)),
             p_a.status::text in ('booked', 'pending_payment') and p_a.starts_at > now(),
             now(),
             case when q.kind = 'provider' then q.name end)::api.appointment_status
  from app.services s
  join app.locations l on l.id = p_a.location_id
  left join app.queues q on q.id = p_a.queue_id
  left join app.booking_policies bp on bp.service_id = p_a.service_id
  where s.id = p_a.service_id
$$;

comment on function api.get_appointment(text) is
  'The guest''s own appointment: times, status, service and location names, the provider line''s name when it '
  'was booked on one (provider_name, else null), whether it can still be moved or cancelled, and the server '
  'time. Never includes contact data or staff accounts. Unknown tokens and tokens past their life (12 h after '
  'the appointment ended or was cancelled) raise the same not_found.';


-- ==================================================================== from 20261112070722_catalog_localized_reads.sql

-- Catalog content from T2 (#1296) has {"en", "es"} strings; T1's apply and listing read them as plain
-- text. Both now read either shape (tracker #1267, unblocks T5-T8 content). Copies stay English: the
-- tenant's own rows have no language of their own yet, and the picker localizes from the payload.
-- Alternatives (rule 7): flatten {en, es} in each content migration (rejected: the catalog would lose the
-- Spanish the guest preview needs) vs read either shape in one helper (chosen). No signature changes.

-- A catalog string in one language: T2 content is {"en", "es"}; the v1 rows are plain text.
create function private.catalog_text(p_value jsonb, p_lang text default 'en') returns text
language sql immutable set search_path = '' as $$
  select case jsonb_typeof(p_value)
    when 'string' then p_value #>> '{}'
    when 'object' then coalesce(p_value ->> p_lang, p_value ->> 'en')
  end
$$;
comment on function private.catalog_text(jsonb, text) is
  'The text of a catalog string for p_lang (English when missing); plain strings are returned as they are; null otherwise.';
-- Pure; executable by signed-in users because api.list_template_catalog runs as the invoker.
revoke all on function private.catalog_text(jsonb, text) from public, anon;
grant execute on function private.catalog_text(jsonb, text) to authenticated, service_role;

-- redefines api.apply_industry_template from 20261109111303_template_catalog.sql
create or replace function api.apply_industry_template(p_location_id uuid, p_template_key text, p_idempotency_key uuid)
returns api.template_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  loc app.locations;
  tpl jsonb;
  v_version int;
  claim record;
  q jsonb;
  s jsonb;
  r jsonb;
  v_queue app.queues;
  result api.template_result;
begin
  select * into loc from app.locations l where l.id = p_location_id;
  if not found or not private.has_role(loc.org_id, loc.id, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_role(loc.org_id, loc.id, 'admin') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  -- The newest catalog version; the rows created below are copies that later versions never touch.
  select c.payload || jsonb_build_object('health_tagged', c.health_tagged), c.version into tpl, v_version
  from app.template_catalog c
  where c.key = p_template_key order by c.version desc limit 1;
  if tpl is null or p_idempotency_key is null then raise exception 'not_found'; end if;

  select * into claim from private.claim_idempotent(loc.org_id, 'apply_industry_template', p_idempotency_key);
  if claim.replay then
    if claim.response ->> 'template_key' is distinct from p_template_key then
      raise exception 'invalid_input'; -- the key was used for a different template
    end if;
    return jsonb_populate_record(null::api.template_result, claim.response);
  end if;
  if exists (select 1 from app.visits v
             where v.location_id = loc.id and v.service_day = private.service_day(loc.id)) then
    raise exception 'invalid_input' using detail = 'location_has_visits';
  end if;

  result := row(p_template_key, 0, 0, 0);
  if (tpl ->> 'health_tagged')::boolean then
    -- The tag covers the whole organization, so it needs an org-wide admin, not one scoped to a place.
    if not private.has_role(loc.org_id, null, 'admin') then
      raise exception 'permission_denied' using errcode = '42501';
    end if;
    update app.locations set display_names_enabled = false where org_id = loc.org_id and display_names_enabled;
    update app.organizations set health_tagged = true where id = loc.org_id;
  end if;

  for q in select * from jsonb_array_elements(tpl -> 'queues') loop
    -- Applying again, or after hand-made setup, never duplicates a queue of the same name.
    select * into v_queue from app.queues x
    where x.location_id = loc.id and x.archived_at is null and x.name = private.catalog_text(q -> 'name');
    if not found then
      insert into app.queues (org_id, location_id, name, ticket_prefix, show_eta,
                              party_size_enabled, party_size_min, party_size_max,
                              origin_template, origin_version)
      values (loc.org_id, loc.id, private.catalog_text(q -> 'name'), q ->> 'prefix', (q ->> 'show_eta')::boolean,
              q ? 'party_max', coalesce((q ->> 'party_min')::int, 1), coalesce((q ->> 'party_max')::int, 1),
              p_template_key, v_version)
      returning * into v_queue;
      result.queues_created := result.queues_created + 1;
    end if;
    for s in select * from jsonb_array_elements(q -> 'services') loop
      if not exists (select 1 from app.services x where x.queue_id = v_queue.id and x.name = private.catalog_text(s -> 'name')) then
        insert into app.services (org_id, location_id, queue_id, name, expected_minutes, ticket_prefix)
        values (loc.org_id, loc.id, v_queue.id, private.catalog_text(s -> 'name'), (s ->> 'minutes')::int, s ->> 'prefix');
        result.services_created := result.services_created + 1;
      end if;
    end loop;
  end loop;
  for r in select * from jsonb_array_elements(tpl -> 'resources') loop
    if not exists (select 1 from app.counters x
                   where x.location_id = loc.id and x.archived_at is null and x.label = private.catalog_text(r -> 'label')) then
      insert into app.counters (org_id, location_id, label, kind, seats)
      values (loc.org_id, loc.id, private.catalog_text(r -> 'label'), (r ->> 'kind')::app.resource_kind, (r ->> 'seats')::int);
      result.counters_created := result.counters_created + 1;
    end if;
  end loop;

  perform private.save_idempotent('apply_industry_template', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.apply_industry_template(uuid, text, uuid) is
  'Creates the template''s queues, services and counters in the location, skipping any with the '
  'same name already there. Owner or admin of the location; refuses (invalid_input, detail '
  'location_has_visits) when the location already has visits in the current service day. A clinic '
  'template tags the organization health_tagged and turns names off on displays for good. Raises '
  'not_found (unknown template or a location the caller cannot see), permission_denied (42501, a '
  'member below admin). Idempotent per key. Localized catalog strings ({en, es}) are copied in English. Uses the newest catalog version and stamps origin_template and origin_version '
  'on the queues it creates. Implemented by 2A-ORG4, T1 (#1295).';

-- redefines api.list_template_catalog from 20261109111303_template_catalog.sql
create or replace function api.list_template_catalog()
returns setof api.template_catalog_entry
language sql stable security invoker set search_path = '' as $$
  select c.key, c.version, private.catalog_text(c.payload -> 'name'), private.catalog_text(c.payload -> 'description'), c.tier, c.mode, c.health_tagged, c.payload
  from (select distinct on (key) * from app.template_catalog order by key, version desc) c
  order by c.tier, c.key
$$;
comment on function api.list_template_catalog() is
  'The newest version of every catalog template with its payload, tier 1 first; name and description in English (the payload keeps every language). Any signed-in user, '
  'including one who has not created an organization yet; anon is denied (42501). Read-only: templates '
  'are applied by api.apply_industry_template, which copies them.';
revoke all on function api.list_template_catalog() from public, anon, authenticated, service_role;
grant execute on function api.list_template_catalog() to authenticated, service_role;

-- ==================================================================== from 20261112071549_sms_template_preview.sql

-- S2 (#1219): the template editor shows an SMS exactly as it is sent, from the database.
-- api.sms_preview returns the locked frame (business name, opt-out line) and the tenant's middle separately,
-- with the segment count and encoding of the whole, so the editor can grey the frame and never re-derive it.
-- With no draft body it previews the template the guest's locale actually resolves to (private.resolve_template),
-- so the Spanish tab shows an English override when that is what a Spanish-speaking guest would get.
-- Why a public RPC (interface rule 1): private.sms_compose is not exposed to PostgREST, and the editor needs the
-- frame split out, which no existing api.* function returns. Alternatives: (a) expose private.sms_compose itself
-- (rejected: it returns only the joined text, and exposing private breaks the schema rule); (b) re-render the frame
-- in TypeScript (rejected: duplicated knowledge, the footer wording is versioned data in app.sms_footers).
-- Security definer because private.resolve_template is not executable by members; the role check comes first and
-- the function reads only the caller's own org (its name, its locations' names, its templates).
create function api.sms_preview(p_org_id uuid, p_trigger text, p_locale text, p_body text default null)
returns table (prefix text, body text, footer text, segments int, encoding text, source text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_locale text := case when p_locale = 'es' then 'es' else 'en' end;
  v_body text := p_body;
  v_source text := 'draft';
  v_full text;
  v_empty text;
  t app.notification_templates;
begin
  if not private.has_role(p_org_id, null, 'staff') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if v_body is null then
    select * into t from private.resolve_template(p_org_id, null, p_trigger, 'sms', v_locale);
    if t.id is null then
      return;
    end if;
    v_body := t.body;
    v_source := case when t.org_id is null then 'default'
                     when t.locale = v_locale then 'custom' else 'custom_other_locale' end;
  end if;
  footer := private.sms_footer(v_locale);
  select c.final_text, c.segments, c.encoding into v_full, segments, encoding
  from private.sms_compose(p_org_id, v_locale, p_trigger, v_body, '{}') c;
  select c.final_text into v_empty from private.sms_compose(p_org_id, v_locale, p_trigger, '', '{}') c;
  -- The frame is "<name>: " + middle + " " + footer, so the empty middle leaves the prefix and the footer.
  prefix := left(v_empty, length(v_empty) - length(footer) - 1);
  body := substr(v_full, length(prefix) + 1, length(v_full) - length(prefix) - length(footer) - 1);
  source := v_source;
  return next;
end $$;
comment on function api.sms_preview(uuid, text, text, text) is
  'An SMS as a guest would receive it, for the template editor: the locked prefix (business name), the tenant''s '
  'middle with sample values filled, the locked opt-out footer, and the segment count and encoding of the whole '
  '(variables take long stand-ins, so segments is a worst case). p_locale es or en. With p_body null, previews the '
  'template the locale resolves to; source is then default, custom, or custom_other_locale (an override in another '
  'language that guests of this locale receive); with a body, source is draft. No row when no SMS template exists '
  'for the trigger. Raises permission_denied unless the caller is staff or above in the org.';
revoke all on function api.sms_preview(uuid, text, text, text) from public, anon;
grant execute on function api.sms_preview(uuid, text, text, text) to authenticated;

-- ==================================================================== from 20261112072327_invite_lines.sql

-- M3b (#1323): assign lines (queues) when inviting staff, and let admins set them, not only owners.
--
-- Before, app.invitations had no queue_ids and the only way to set memberships.queue_ids was an owner's
-- direct table write, so a new hire was unscoped until an owner edited them.
--
-- * app.invitations.queue_ids: same rule as memberships.queue_ids (staff only, non-empty, the org's queues).
-- * api.create_invitation gains a trailing p_queue_ids default null (rule 1: extend, don't add). Old callers
--   (the invite-staff function and bundles that pass six named arguments) keep working unchanged.
-- * api.accept_invitation copies it to the new membership; the memberships trigger checks it again.
-- * api.set_member_lines(membership, queue_ids, key): owners and admins set a staff member's lines.
--
-- Alternatives (rule 7) for the admin path: a defaulted p_queue_ids on api.set_member_role (the ticket's
-- preference) vs a new api.set_member_lines (chosen). set_member_role is a fixed 2A signature, and null
-- already means "every line", so a defaulted parameter cannot tell "leave the lines alone" from "all lines"
-- without a second flag; every caller that changes a role would risk wiping a scope. The same split already
-- exists for locations (set_member_locations) and custom roles (set_member_custom_role).

/** True when the list is null or a non-empty set of the org's queues that the caller's locations cover. */
create function private.valid_member_queue_ids(p_org_id uuid, p_queue_ids uuid[]) returns boolean
language sql stable set search_path = '' as $$
  select p_queue_ids is null or (
    cardinality(p_queue_ids) > 0
    and array_position(p_queue_ids, null) is null
    and (select count(*) from app.queues q where q.org_id = p_org_id and q.id = any (p_queue_ids))
        = (select count(distinct x) from unnest(p_queue_ids) x)
    and private.actor_covers(p_org_id, (select array_agg(distinct q.location_id) from app.queues q
                                         where q.org_id = p_org_id and q.id = any (p_queue_ids))))
$$;
comment on function private.valid_member_queue_ids(uuid, uuid[]) is
  'Null (every line), or a non-empty list of distinct queues of the org whose locations the caller''s own '
  'membership covers. Used by create_invitation and set_member_lines.';
revoke all on function private.valid_member_queue_ids(uuid, uuid[]) from public, anon, authenticated;

alter table app.invitations add column queue_ids uuid[];
alter table app.invitations add constraint invitations_queue_ids_staff
  check (queue_ids is null or (role = 'staff' and cardinality(queue_ids) > 0));
comment on column app.invitations.queue_ids is
  'Lines the invited staff member is limited to (copied to memberships.queue_ids on accept). Null = every line.';
grant select (queue_ids) on app.invitations to authenticated;

-- redefines api.create_invitation from 20261102001636_invite_seat_limit.sql
drop function api.create_invitation(uuid, text, text, uuid[], text, uuid);
create function api.create_invitation(p_org_id uuid, p_email text, p_role text, p_location_ids uuid[], p_display_name text, p_idempotency_key uuid,
                                      p_queue_ids uuid[] default null)
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
  -- M3b: lines only narrow a staff invite (as on memberships, a higher role is unscoped); a location-scoped
  -- admin can only hand out lines at their own locations.
  if v_role <> 'staff' then p_queue_ids := null; end if;
  if not private.valid_member_queue_ids(p_org_id, p_queue_ids) then
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
    insert into app.invitations (org_id, email, role, location_ids, display_name, token_hash, invited_by, queue_ids)
    values (p_org_id, v_email, v_role, p_location_ids, v_name, private.token_hash(token), (select auth.uid()), p_queue_ids)
    returning * into inv;
  exception when unique_violation then
    raise exception 'rate_limited'; -- a concurrent invite for this address won; try again
  end;
  perform private.save_idempotent('create_invitation', p_idempotency_key, to_jsonb(private.invitation_row(inv)));
  return private.invitation_row(inv, token);
end $$;

comment on function api.create_invitation(uuid, text, text, uuid[], text, uuid, uuid[]) is
  'Invites an email to the org with a role, locations and, for staff, lines (p_queue_ids, null = every '
  'line; ignored for other roles). Owners may invite any role, admins manager and staff only. Returns the '
  'plaintext token once; only its sha256 is stored, so an idempotent replay returns the invitation without '
  'it. A new invite replaces the pending one for the same address. Raises forbidden_role, '
  'permission_denied, invalid_input (bad email, location, lines that are empty, not the org''s or outside '
  'the caller''s locations, or an address that is already a member), not_found (not a member), '
  'rate_limited, and plan_limit_reached (members plus pending invitations to other addresses have reached '
  'the plan''s limit.members; the error detail is the limit; inviting an address that already has a '
  'pending invitation never raises it). Implemented by 2A-TM1, lines by M3b.';
revoke all on function api.create_invitation(uuid, text, text, uuid[], text, uuid, uuid[]) from public, anon;
grant execute on function api.create_invitation(uuid, text, text, uuid[], text, uuid, uuid[]) to authenticated, service_role;

-- redefines api.accept_invitation from 20261030061824_invitations.sql (its comment was last set by
-- 20261102001636_invite_seat_limit.sql and still holds; the body only adds queue_ids to the insert)
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
    insert into app.memberships (org_id, user_id, role, location_ids, display_name, queue_ids)
    values (inv.org_id, uid, inv.role, inv.location_ids, inv.display_name, inv.queue_ids)
    on conflict (org_id, user_id) do nothing;
  end if;
  select * into mem from app.memberships m where m.org_id = inv.org_id and m.user_id = uid;
  if not found then raise exception 'not_found'; end if;
  return private.membership_row(mem);
end $$;

create function api.set_member_lines(p_membership_id uuid, p_queue_ids uuid[], p_idempotency_key uuid)
returns api.membership_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  m app.memberships;
  actor app.member_role;
  claim record;
begin
  select * into m from app.memberships where id = p_membership_id for update;
  if not found then raise exception 'not_found'; end if;
  actor := private.require_people_manager(m.org_id, 'staff');
  if p_idempotency_key is null then raise exception 'invalid_input'; end if;
  -- Lines narrow staff only; nobody scopes themselves; a location-scoped admin manages only members and
  -- lines inside their own locations.
  if m.role <> 'staff' or m.user_id = (select auth.uid()) or not private.can_manage_role(actor, m.role)
     or not private.actor_covers(m.org_id, m.location_ids) then
    raise exception 'forbidden_role';
  end if;
  if not private.valid_member_queue_ids(m.org_id, p_queue_ids) then
    raise exception 'invalid_input';
  end if;

  select * into claim from private.claim_idempotent(m.org_id, 'set_member_lines', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.membership_row, claim.response);
  end if;
  update app.memberships set queue_ids = p_queue_ids where id = m.id returning * into m;
  perform private.save_idempotent('set_member_lines', p_idempotency_key, to_jsonb(private.membership_row(m)));
  return private.membership_row(m);
end $$;
comment on function api.set_member_lines(uuid, uuid[], uuid) is
  'Sets the lines (queues) a staff member is limited to while the org has scope_staff_to_lines on (null = '
  'every line) and leaves role and locations alone. Owners and admins; nobody changes their own; a '
  'location-scoped admin only for members and lines within their locations. Every change is in the audit '
  'log. Raises not_found (unknown or foreign id), permission_denied (below admin), forbidden_role (not a '
  'staff member, oneself, or outside the caller''s reach), invalid_input (empty list, a queue of another org '
  'or outside the caller''s locations, no key), org_suspended. Idempotent per key.';
revoke all on function api.set_member_lines(uuid, uuid[], uuid) from public, anon;
grant execute on function api.set_member_lines(uuid, uuid[], uuid) to authenticated, service_role;


-- ==================================================================== from 20261112073114_visit_answers_read.sql

-- F7 (#1283, tracker #1267): staff read a visit's form answers through api.get_visit_answers, which logs
-- the access. Postgres cannot audit a plain SELECT, so the read that writes the log must be the one the
-- console uses (interface rule 5). Riz 2026-11-09: location-wide staff access is the default; queue scope
-- (M1) still applies through private.has_queue_access.
--
-- * api.get_visit_answers(visit): the form version the visit was asked (else the one a walk-in would
--   get now, as set_visit_answers validates against), its fields in form order with their visibility,
--   and the answers. Writes an audit_log READ row (who, when, visit; never values), at most one per
--   member and visit every 10 minutes so a live console refetching on every signal does not flood it.
-- * audit_log.action gains READ.
--
-- Why not a pass-through: it owns the access-log invariant, and it reads the versioned form (service
-- forms included), which the old intake_fields read missed.
-- Alternatives (rule 7): an audit trigger on SELECT (impossible in Postgres) or logging from the client
-- (skippable) vs a definer read that logs in the same call (chosen, as api.export_waiver_records does).
-- Expand step (I-12): the direct SELECT policies on app.visit_answers and app.form_responses stay until
-- console bundles that read them have aged out; the contract step that revokes them is a follow-up issue.

alter table app.audit_log drop constraint audit_log_action_check;
alter table app.audit_log add constraint audit_log_action_check
  check (action in ('INSERT', 'UPDATE', 'DELETE', 'EXPORT', 'ERASE', 'READ'));

create function api.get_visit_answers(p_visit_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  os app.operator_sessions := private.operator_session();
  v_me uuid := coalesce(os.operator_user_id, (select auth.uid()));
  v_ver uuid;
  v_answers jsonb;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  v_ver := (select r.form_version_id from app.form_responses r where r.visit_id = v.id order by r.created_at limit 1);
  v_ver := coalesce(v_ver, private.resolve_form(v.queue_id, v.service_id));
  v_answers := coalesce(
    (select r.answers from app.form_responses r where r.visit_id = v.id and r.form_version_id = v_ver),
    (select a.answers from app.visit_answers a where a.visit_id = v.id),
    '{}');

  if not exists (
    select 1 from app.audit_log l
    where l.org_id = v.org_id and l.action = 'READ' and l.table_name = 'form_responses'
      and l.row_id = v.id::text and l.actor is not distinct from v_me and l.at > now() - interval '10 minutes'
  ) then
    insert into app.audit_log (org_id, actor, role, action, table_name, row_id, after)
    values (v.org_id, v_me,
            (select m.role::text from app.memberships m where m.org_id = v.org_id and m.user_id = v_me
             order by m.role desc limit 1),
            'READ', 'form_responses', v.id::text, jsonb_build_object('kind', 'answers_read'));
  end if;

  return jsonb_build_object(
    'location_id', v.location_id,
    'form_version_id', v_ver,
    'fields', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'key', e ->> 'key', 'label', e ->> 'label', 'help', e -> 'help', 'type', e ->> 'type',
               'options', e -> 'options', 'required', coalesce((e ->> 'required')::boolean, false),
               'visibility', coalesce(e ->> 'visibility', 'guest'), 'sensitivity', e ->> 'sensitivity'))
             order by ord)
      from app.form_versions fv,
           jsonb_array_elements(private.normalize_form_fields(fv.fields)) with ordinality t(e, ord)
      where fv.id = v_ver), '[]'),
    'answers', v_answers);
end $$;
comment on function api.get_visit_answers(uuid) is
  'The form answers of a visit for staff: {location_id, form_version_id, fields[], answers}. fields are '
  'the form version the visit was asked (else the one a walk-in on its queue and service gets now) in form '
  'order with key, label, help, type (canonical), options, required, visibility (guest | staff_only) and '
  'sensitivity; answers is the stored object. Staff of the location, and of the queue when the org limits '
  'staff to their lines; anything else, or an unknown visit, raises not_found. Every call is an audited '
  'access: an audit_log READ row (who, when, visit, never values), at most one per member and visit per '
  '10 minutes.';
revoke all on function api.get_visit_answers(uuid) from public, anon;
grant execute on function api.get_visit_answers(uuid) to authenticated;


-- ==================================================================== from 20261112075127_provider_line_person.sql

-- #1388 (follow-up to M7 #1294): a provider line names its person, and its bookings only ever go to them.
--
-- Before, nothing tied a provider line (queues.kind 'provider') to a person: with location-wide staff
-- availability, a guest who booked Dr Ada's line could be assigned Dr Ben, and Ada's line showed slots
-- whenever anyone was free.
--
-- Alternatives (rule 7, product call by the coordinator 2026-11-12): queues.provider_user_id (chosen) vs
-- deriving the person from memberships.queue_ids (rejected: scoping is optional and off by default, so it
-- would silently do nothing for most orgs, and a front-desk member scoped to the line is not its provider).
--
-- * app.queues.provider_user_id: the member whose line it is. Provider lines only; the member must work at
--   the line's location. Removing the member clears it (the line falls back to "anyone", as before).
-- * private.slot_candidates: on a provider line with a person, every availability window of the service is
--   that person's and nobody else's windows count, so free_staff is them or nobody, at most one booking per
--   slot, and private.book_core assigns them. Lines without a person behave exactly as before.
-- No new entry point: managers set the column under the existing queues_update policy (config table).

alter table app.queues
  add column provider_user_id uuid,
  add constraint queues_provider_user_kind check (provider_user_id is null or kind = 'provider'),
  add constraint queues_provider_user_fk foreign key (org_id, provider_user_id)
    references app.memberships (org_id, user_id) on delete set null (provider_user_id);
create index queues_provider_user_idx on app.queues (provider_user_id) where provider_user_id is not null;
comment on column app.queues.provider_user_id is
  'For a provider line: the member whose line it is. Bookings on its services are only offered and assigned '
  'to them. Null = anyone available at the location (the behaviour before #1388).';

-- Security definer: a manager setting the person cannot read other members' rows under RLS.
create function private.check_queue_provider() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.provider_user_id is not null and not exists (
    select 1 from app.memberships m
    where m.org_id = new.org_id and m.user_id = new.provider_user_id
      and (m.location_ids is null or new.location_id = any (m.location_ids))
  ) then
    raise exception 'invalid_input' using detail = 'provider_user_id is not a member of the location';
  end if;
  return new;
end $$;
comment on function private.check_queue_provider() is
  'BEFORE INSERT OR UPDATE on app.queues: a provider line''s person must be a member who works at its location (invalid_input).';
revoke all on function private.check_queue_provider() from public, anon, authenticated;
create trigger queues_check_provider before insert or update of provider_user_id, location_id on app.queues
  for each row execute function private.check_queue_provider();

-- redefines private.slot_candidates from 20261031033440_require_card_for_paid_bookings.sql
create or replace function private.slot_candidates(p_service_id uuid, p_from date, p_to date, p_now timestamptz default now(), p_ignore_capacity boolean default false)
returns setof private.slot_candidate
language plpgsql stable set search_path = '' as $$
declare
  s app.services;
  bp app.booking_policies;
  l app.locations;
  dur int;
  today date;
  has_rules boolean;
  v_provider uuid;
begin
  select * into s from app.services where id = p_service_id and active;
  select * into bp from app.booking_policies where service_id = p_service_id and bookable;
  if s.id is null or bp.id is null then return; end if;
  select * into l from app.locations where id = s.location_id;
  if not exists (select 1 from app.organizations o where o.id = l.org_id and o.status = 'active') then return; end if;
  dur := coalesce(bp.duration_minutes, s.expected_minutes);
  -- #1388: a provider line with its person takes bookings for that person only. Every availability window
  -- of the service (an "anyone" window too) is theirs, and other people's windows don't count.
  select q.provider_user_id into v_provider from app.queues q where q.id = s.queue_id and q.kind = 'provider';
  today := (p_now at time zone l.tz)::date;
  has_rules := exists (select 1 from app.availability_rules r
                       where r.location_id = l.id and (r.service_id is null or r.service_id = s.id));

  return query
  with days as (
    select gs::date as d from generate_series(greatest(p_from, today), least(p_to, today + bp.max_days_ahead), '1 day') gs
  ),
  biz as ( -- opening windows as instants (a window may cross midnight)
    select d.d,
           (d.d + o.opens) at time zone l.tz as w_start,
           (d.d + case when o.closes <= o.opens then 1 else 0 end + o.closes) at time zone l.tz as w_end
    from days d
    cross join lateral (
      select e.opens, e.closes from app.hours_exceptions e
      where e.location_id = l.id and e.date = d.d and not e.closed
      union all
      select h.opens, h.closes from app.business_hours h
      where h.location_id = l.id and h.weekday = extract(dow from d.d)
        and not exists (select 1 from app.hours_exceptions e where e.location_id = l.id and e.date = d.d)
    ) o
  ),
  avail as ( -- availability windows per staff member (null = any staff; the line's person on a provider line)
    select d.d, coalesce(r.staff_user_id, v_provider) as staff_user_id,
           (d.d + r.starts) at time zone l.tz as a_start,
           (d.d + case when r.ends <= r.starts then 1 else 0 end + r.ends) at time zone l.tz as a_end
    from days d join app.availability_rules r
      on r.location_id = l.id and (r.service_id is null or r.service_id = s.id)
     and r.weekday = extract(dow from d.d)
     and (r.valid_from is null or d.d >= r.valid_from) and (r.valid_to is null or d.d <= r.valid_to)
    where v_provider is null or coalesce(r.staff_user_id, v_provider) = v_provider
    union all
    select x.local_date, coalesce(x.staff_user_id, v_provider),
           (x.local_date + x.starts) at time zone l.tz,
           (x.local_date + case when x.ends <= x.starts then 1 else 0 end + x.ends) at time zone l.tz
    from app.availability_exceptions x
    where x.location_id = l.id and x.kind = 'extra' and x.local_date between p_from and p_to
      and (v_provider is null or coalesce(x.staff_user_id, v_provider) = v_provider)
  ),
  off as ( -- unavailable windows (null staff = everyone; null times = the whole day)
    select x.staff_user_id,
           tstzrange((x.local_date + coalesce(x.starts, time '00:00')) at time zone l.tz,
                     case when x.starts is null then (x.local_date + 1) at time zone l.tz
                          else (x.local_date + case when x.ends <= x.starts then 1 else 0 end + x.ends) at time zone l.tz end) as r
    from app.availability_exceptions x
    where x.location_id = l.id and x.kind = 'unavailable' and x.local_date between p_from - 1 and p_to
  ),
  rs as ( -- resources that can serve the service
    select ctr.id from app.counters ctr
    where ctr.location_id = l.id and ctr.active
      and (not exists (select 1 from app.service_resources m where m.service_id = s.id)
           or exists (select 1 from app.service_resources m where m.service_id = s.id and m.counter_id = ctr.id))
  ),
  cand as (
    select (b.w_start + m * interval '1 minute') as st,
           (b.w_start + (m + dur) * interval '1 minute') as en,
           b.d
    from biz b
    cross join lateral generate_series(bp.slot_offset_minutes,
        (extract(epoch from (b.w_end - b.w_start)) / 60)::int - dur, bp.slot_minutes) m
  ),
  checked as (
    select c.st, c.en, c.d,
      -- staff who could take the slot: covered by an availability window, not off, not double-booked
      (select coalesce(array_agg(distinct a.staff_user_id), '{}'::uuid[]) from avail a
        where a.staff_user_id is not null and a.d = c.d and a.a_start <= c.st and a.a_end >= c.en
          and not exists (select 1 from off f where (f.staff_user_id is null or f.staff_user_id = a.staff_user_id)
                          and f.r && tstzrange(c.st, c.en))
          and not exists (select 1 from app.time_blocks tb join app.counters bc on bc.id = tb.counter_id
                          where bc.location_id = l.id and bc.kind = 'staff' and bc.member_user_id = a.staff_user_id
                            and tb.during && tstzrange(c.st, c.en))
          and not exists (select 1 from app.appointments ap
                          where ap.staff_user_id = a.staff_user_id and (ap.status in ('booked', 'checked_in') or ap.payment_due_at is not null)
                            and ap.starts_at >= c.st - interval '1 day' and ap.starts_at < c.en + interval '1 day'
                            and tstzrange(ap.starts_at - bp.buffer_before_minutes * interval '1 minute',
                                          ap.ends_at + bp.buffer_after_minutes * interval '1 minute') && tstzrange(c.st, c.en))
      ) as free_staff,
      exists (select 1 from avail a where a.staff_user_id is null and a.d = c.d and a.a_start <= c.st and a.a_end >= c.en) as any_staff,
      exists (select 1 from off f where f.staff_user_id is null and f.r && tstzrange(c.st, c.en)) as closed_all,
      -- 2B-A11: every resource that can do the service (its mapped resources, else all active ones at the
      -- location) is blocked during the slot.
      (exists (select 1 from rs) and not exists (
         select 1 from rs where not exists (select 1 from app.time_blocks tb
                                            where tb.counter_id = rs.id and tb.during && tstzrange(c.st, c.en)))) as blocked_all,
      (select count(*)::int from app.appointments ap
        where (bp.buffer_before_minutes > 0 or bp.buffer_after_minutes > 0)
          and ap.service_id = s.id and ap.staff_user_id is null and (ap.status in ('booked', 'checked_in') or ap.payment_due_at is not null)
          and ap.starts_at <> c.st and ap.starts_at >= c.st - interval '1 day' and ap.starts_at < c.en + interval '1 day'
          and tstzrange(ap.starts_at - bp.buffer_before_minutes * interval '1 minute',
                        ap.ends_at + bp.buffer_after_minutes * interval '1 minute') && tstzrange(c.st, c.en)) as overlap,
      coalesce((select cr.capacity from app.capacity_rules cr
                where cr.service_id = s.id and cr.scope = 'slot'
                  and (cr.local_date = c.d or (cr.local_date is null and (cr.weekday is null or cr.weekday = extract(dow from c.d))))
                order by (cr.local_date is not null) desc, (cr.weekday is not null) desc limit 1), 1) as cap,
      (select cr.capacity from app.capacity_rules cr
        where cr.service_id = s.id and cr.scope = 'day'
          and (cr.local_date = c.d or (cr.local_date is null and (cr.weekday is null or cr.weekday = extract(dow from c.d))))
        order by (cr.local_date is not null) desc, (cr.weekday is not null) desc limit 1) as day_cap,
      coalesce((select n.count from app.appointment_slot_counts n where n.service_id = s.id and n.slot_start = c.st), 0) as used,
      coalesce((select n.count from app.appointment_day_counts n where n.service_id = s.id and n.local_date = c.d), 0) as day_used
    from cand c
    where c.st >= p_now + bp.min_notice_minutes * interval '1 minute'
  )
  select k.st, k.en,
         case when p_ignore_capacity then 1 else least(k.cap - k.used - k.overlap, coalesce(k.day_cap - k.day_used, 1000000),
              case when k.any_staff or not has_rules then 1000000 else cardinality(k.free_staff) end)::int end,
         k.free_staff, k.any_staff
  from checked k
  where not k.closed_all and not k.blocked_all
    and (not has_rules or k.any_staff or cardinality(k.free_staff) > 0)
    and (p_ignore_capacity or least(k.cap - k.used - k.overlap, coalesce(k.day_cap - k.day_used, 1000000),
              case when k.any_staff or not has_rules then 1000000 else cardinality(k.free_staff) end) > 0)
  order by k.st;
end $$;

comment on function private.slot_candidates(uuid, date, date, timestamptz, boolean) is
  'The slot rules (see 20261030062750_appointments.sql for the semantics): every slot of a service in a '
  'date range with its remaining seats and the staff who could take it. On a provider line with a person '
  '(queues.provider_user_id) only that person can take it, and every availability window of the service '
  'counts as theirs. p_ignore_capacity lists slots that are valid but full, which is how booking tells '
  'slot_unavailable from slot_full.';


-- ==================================================================== from 20261112075140_member_phone_test_sms.sql

-- S2b (#1389): a member confirms their own phone with a code, then sends themselves a test of a guest SMS.
-- The template editor ("Send me a test") and the SMS setup step (T1 #1236) use the same three functions.
--   * app.member_phones: one row per member per org: the number they typed, whether it is confirmed, the hash of
--     the pending code. Members read only their own row; every write goes through the functions below.
--   * api.start_member_phone(org, phone): stores the number (unconfirmed again if it changed) and texts a 6-digit
--     code through the outbox (I-11). At most 3 codes per member and 10 per org a day: the code goes from the shared
--     sender to a number a member typed, so it must not become a way to text strangers.
--   * api.confirm_member_phone(org, code): true when confirmed, false for a wrong code; 5 tries, 10 minutes.
--   * api.send_member_test_sms(org, trigger): queues the org's real template for the trigger, with sample values,
--     to the member's confirmed number. At most 5 a day per member; billed, capped and paused like any other text.
-- Both texts are framed like a guest's (business name first, STOP/HELP last): api.claim_outbox now frames SMS rows
-- addressed to a member phone, and private.notification_address resolves them. The member asked for these texts;
-- a STOP from the number still suppresses them (claim_outbox checks app.suppressions as for any row).
-- Alternatives: (a) reuse the guest code flow (rejected: it is tied to a visit and its contact row; members are not
-- guests); (b) send the test from an Edge Function (rejected: only the outbox sends, I-11, and a test must pass the
-- same credit, pause and suppression checks as a real text). New public RPCs (rule 1): there is no member-phone
-- entry point to extend.
-- redefines api.claim_outbox from 20261108005646_sms_safe_names.sql
-- redefines private.notification_address from 20261109172323_guest_notice_typed_emails.sql
-- The trigger constraint is copied from 20261109203708_waiver_purge_reminder.sql with member_verify added.

create table app.member_phones (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  verified_at timestamptz,
  code_hash bytea,
  code_expires_at timestamptz,
  code_attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);
comment on table app.member_phones is
  'A member''s own phone in one org, for test texts. verified_at is set once they enter the code sent to it. '
  'Read by the member only; written only by api.start_member_phone and api.confirm_member_phone.';
alter table app.member_phones enable row level security;
create policy member_phones_select on app.member_phones for select to authenticated
  using (user_id = (select auth.uid()) and (select private.has_role(org_id, null, 'staff')));
revoke all on app.member_phones from public, anon, authenticated;
grant select (id, org_id, user_id, phone_e164, verified_at, created_at, updated_at) on app.member_phones to authenticated;
create trigger member_phones_org_immutable before update on app.member_phones
  for each row execute function private.forbid_org_change();

create function private.is_member_phone(p_id uuid, p_org_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.member_phones mp where mp.id = p_id and mp.org_id = p_org_id)
$$;
comment on function private.is_member_phone(uuid, uuid) is 'True when p_id is a member_phones row of p_org_id (an outbox recipient).';
revoke all on function private.is_member_phone(uuid, uuid) from public, anon, authenticated;

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary',
                     'credit_low', 'receipt', 'reply_verify', 'payment_failed', 'payment_grace_ending',
                     'support_request', 'support_confirmation', 'appointment_expired', 'reply_confirm_number',
                     'sms_paused', 'sms_paused_operator', 'sms_warning_operator', 'sms_digest_operator',
                     'incident_notice', 'incident_reported_operator', 'guest_incident_notice',
                     'waiver_records_expiring', 'member_verify'));

insert into app.notification_templates (trigger, channel, locale, category, subject, body) values
  ('member_verify', 'sms', 'en', 'transactional', null,
   'Your code to confirm this phone for test texts is {code}. It expires in 10 minutes.');

------------------------------------------------------------------------------------------------
create function api.start_member_phone(p_org_id uuid, p_phone text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[ ().-]', '', 'g');
  v_code text := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint & 2147483647) % 1000000)::text, 6, '0');
  mp app.member_phones;
begin
  if v_uid is null or not private.has_role(p_org_id, null, 'manager') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid_input' using detail = 'phone';
  end if;
  -- One org at a time, so the caps below are exact under concurrent requests.
  perform pg_advisory_xact_lock(hashtextextended('member_phone:' || p_org_id, 0));
  if (select count(*) from app.notifications n join app.member_phones x on x.id = n.recipient_ref
      where x.org_id = p_org_id and x.user_id = v_uid and n.org_id = p_org_id and n.template_key = 'member_verify'
        and n.created_at > now() - interval '1 day') >= 3
     or (select count(*) from app.notifications n
         where n.org_id = p_org_id and n.template_key = 'member_verify' and n.created_at > now() - interval '1 day') >= 10 then
    raise exception 'rate_limited';
  end if;
  insert into app.member_phones as m (org_id, user_id, phone_e164, code_hash, code_expires_at)
  values (p_org_id, v_uid, v_phone, extensions.digest(v_code, 'sha256'), now() + interval '10 minutes')
  on conflict (org_id, user_id) do update
    set phone_e164 = excluded.phone_e164, code_hash = excluded.code_hash, code_expires_at = excluded.code_expires_at,
        code_attempts = 0, updated_at = now(),
        verified_at = case when m.phone_e164 = excluded.phone_e164 then m.verified_at end
  returning * into mp;
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category,
                                 vars, dedupe_key)
  select p_org_id, null, 'sms', mp.id, 'member_verify', t.version, t.category,
         jsonb_build_object('code', v_code, 'location_name', o.name),
         'member_verify:' || mp.id || ':' || gen_random_uuid()
  from app.organizations o
  cross join lateral private.resolve_template(p_org_id, null, 'member_verify', 'sms', 'en') t
  where o.id = p_org_id;
end $$;
comment on function api.start_member_phone(uuid, text) is
  'Saves the caller''s own phone for this org (E.164; spaces, dots, dashes and brackets ignored) and texts it a 6-digit '
  'code valid for 10 minutes, replacing any earlier code. A number different from the saved one must be confirmed '
  'again. Managers and above. Errors: permission_denied, invalid_input (not a phone number), rate_limited (more than 3 '
  'codes for the member or 10 for the org in 24 hours).';
revoke all on function api.start_member_phone(uuid, text) from public, anon;
grant execute on function api.start_member_phone(uuid, text) to authenticated;

create function api.confirm_member_phone(p_org_id uuid, p_code text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  mp app.member_phones;
begin
  if v_uid is null or not private.has_role(p_org_id, null, 'manager') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  select * into mp from app.member_phones m where m.org_id = p_org_id and m.user_id = v_uid for update;
  if mp.id is null or mp.code_hash is null then
    raise exception 'not_found';
  end if;
  if mp.code_expires_at < now() or mp.code_attempts >= 5 then
    raise exception 'code_expired';
  end if;
  if extensions.digest(btrim(coalesce(p_code, '')), 'sha256') <> mp.code_hash then
    -- Returned, not raised, so the counted attempt is kept.
    update app.member_phones set code_attempts = code_attempts + 1, updated_at = now() where id = mp.id;
    return false;
  end if;
  update app.member_phones
  set verified_at = now(), code_hash = null, code_expires_at = null, code_attempts = 0, updated_at = now()
  where id = mp.id;
  return true;
end $$;
comment on function api.confirm_member_phone(uuid, text) is
  'Confirms the caller''s saved phone with the code texted by api.start_member_phone: true when it matches, false '
  'for a wrong code (counted). Errors: permission_denied, not_found (no code pending), code_expired (older than 10 '
  'minutes or 5 wrong tries: ask for a new code).';
revoke all on function api.confirm_member_phone(uuid, text) from public, anon;
grant execute on function api.confirm_member_phone(uuid, text) to authenticated;

create function api.send_member_test_sms(p_org_id uuid, p_trigger text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  mp app.member_phones;
begin
  if v_uid is null or not private.has_role(p_org_id, null, 'manager') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_trigger is null or p_trigger not in ('called', 'almost_up', 'position_changed', 'eta_changed') then
    raise exception 'invalid_trigger';
  end if;
  select * into mp from app.member_phones m where m.org_id = p_org_id and m.user_id = v_uid for update;
  if mp.verified_at is null then
    raise exception 'phone_not_verified';
  end if;
  if (select count(*) from app.notifications n
      where n.org_id = p_org_id and n.recipient_ref = mp.id and n.template_key <> 'member_verify'
        and n.created_at > now() - interval '1 day') >= 5 then
    raise exception 'rate_limited';
  end if;
  -- The org's own wording for the trigger (an inactive or missing template has nothing to test).
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category,
                                 vars, dedupe_key)
  select p_org_id, null, 'sms', mp.id, p_trigger, t.version, t.category,
         jsonb_build_object('location_name', o.name, 'ticket', 'A-123', 'counter', 'Counter 3', 'position', '3',
                            'eta_range', '10-15 min', 'guest_first_name', 'Alex'),
         'member_test:' || mp.id || ':' || gen_random_uuid()
  from app.organizations o
  cross join lateral private.resolve_template(p_org_id, null, p_trigger, 'sms', o.default_locale) t
  where o.id = p_org_id;
  if not found then
    raise exception 'not_found';
  end if;
end $$;
comment on function api.send_member_test_sms(uuid, text) is
  'Texts the caller''s confirmed phone the org''s current SMS for p_trigger (called, almost_up, position_changed, '
  'eta_changed) in the org''s language, framed and filled with sample values, through the outbox: billed, capped and '
  'paused like a guest text. Managers and above. Errors: permission_denied, invalid_trigger, phone_not_verified, '
  'not_found (no active SMS template for the trigger), rate_limited (5 tests a member a day).';
revoke all on function api.send_member_test_sms(uuid, text) from public, anon;
grant execute on function api.send_member_test_sms(uuid, text) to authenticated;

------------------------------------------------------------------------------------------------
create or replace function private.notification_address(
  p_channel app.notification_channel,
  p_visit_id uuid,
  p_recipient_ref uuid,
  p_org_id uuid
) returns text
language sql stable set search_path = '' as $$
  select case
    when p_channel = 'push' then null
    when p_visit_id is null and p_channel = 'email'
         and exists (select 1 from app.support_requests r where r.id = p_recipient_ref and r.org_id = p_org_id) then
      private.support_inbox()
    -- The org's privacy/breach contact: the org itself is the recipient, and only its own row counts.
    when p_visit_id is null and p_channel = 'email' and p_recipient_ref = p_org_id
         and exists (select 1 from app.org_privacy p where p.org_id = p_org_id) then (
      select p.email from app.org_privacy p where p.org_id = p_org_id)
    -- What the guest typed when booking: the appointment itself is the recipient.
    when p_visit_id is null and p_channel = 'email'
         and exists (select 1 from app.appointments a where a.id = p_recipient_ref) then (
      select case p_channel when 'email' then a.guest_email else a.guest_phone_e164 end
      from app.appointments a where a.id = p_recipient_ref and a.org_id = p_org_id)
    -- What the guest typed when joining: the visit itself is the recipient (a guest notice has no visit
    -- of its own to attach to, because a visit's state would decide whether it is still worth sending).
    when p_visit_id is null and p_channel = 'email'
         and exists (select 1 from app.visits v where v.id = p_recipient_ref and v.org_id = p_org_id) then (
      select v.guest_email from app.visits v where v.id = p_recipient_ref and v.org_id = p_org_id)
    -- A member's own phone (S2b): the member_phones row is the recipient, and only its own org's row counts.
    when p_visit_id is null and p_channel = 'sms' and private.is_member_phone(p_recipient_ref, p_org_id) then (
      select mp.phone_e164 from app.member_phones mp where mp.id = p_recipient_ref and mp.org_id = p_org_id)
    when p_visit_id is null and exists (select 1 from auth.users u where u.id = p_recipient_ref) then (
      select u.email from auth.users u where u.id = p_recipient_ref)
    when p_recipient_ref = p_visit_id then (
      select case p_channel when 'email' then v.guest_email else v.guest_phone_e164 end
      from app.visits v where v.id = p_visit_id)
    else (select gc.value from app.guest_contacts gc where gc.id = p_recipient_ref and gc.org_id = p_org_id)
  end
$$;

create or replace function api.claim_outbox(p_limit int, p_lease_seconds int) returns setof api.outbox_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 200
     or p_lease_seconds is null or p_lease_seconds not between 1 and 600 then
    raise exception 'invalid_input';
  end if;

  -- Send window (3-CG9, C5): a row that is outside its window waits for the next opening instead of
  -- being claimed, so a deferral costs no attempt and no dispatcher call. private.send_window_open owns
  -- which rows are exempt.
  update app.notifications n
  set next_attempt_at = w.opens, quiet_hours_deferred = true
  from (select x.id, private.next_send_window(coalesce(v.location_id, ap.location_id), now()) as opens
        from app.notifications x
        left join app.visits v on v.id = x.visit_id
        left join app.appointments ap on ap.id = x.appointment_id
        where x.status in ('queued', 'failed') and x.next_attempt_at <= now()
          and not private.send_window_open(coalesce(v.location_id, ap.location_id), x.template_key, x.channel, now())
        for update of x skip locked) w
  where n.id = w.id and w.opens > now();

  update app.notifications
  set status = 'dead', error_code = 'lease_expired', locked_until = null
  where status = 'claimed' and locked_until < now() and attempts + 1 >= private.outbox_max_attempts();

  return query
  with due as (
    select n.id
    from app.notifications n
    left join app.visits dv on dv.id = n.visit_id
    left join app.appointments dap on dap.id = n.appointment_id
    where ((n.status in ('queued', 'failed') and n.next_attempt_at <= now())
        or (n.status = 'claimed' and n.locked_until < now()))
      -- The window is checked again here: nothing outside it is ever claimed, whatever was queued
      -- after the deferral pass above.
      and private.send_window_open(coalesce(dv.location_id, dap.location_id), n.template_key, n.channel, now())
    order by n.next_attempt_at
    limit p_limit
    for update of n skip locked
  ),
  claimed as (
    update app.notifications n
    set status = 'claimed',
        locked_until = now() + make_interval(secs => p_lease_seconds),
        attempts = n.attempts + case when n.status = 'claimed' then 1 else 0 end,
        consent_id = case when n.channel = 'push' or (n.visit_id is null and n.appointment_id is null) then null else (
          select c.id from app.consents c
          where c.contact_id = n.recipient_ref and c.channel = n.channel and c.purpose = n.category
          order by c.captured_at desc limit 1) end,
        recipient_hash = case when n.channel <> 'push' and (n.visit_id is not null or n.appointment_id is not null) then
          encode(sha256(convert_to(private.canonical_email(
            private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)), 'UTF8')), 'hex')
        end
    from due
    where n.id = due.id
    returning n.*
  )
  select n.id, n.org_id, n.visit_id, n.channel, n.category, n.template_key, n.template_version,
         coalesce(v.locale, ap.locale, o.default_locale), t.subject, case when n.channel = 'sms' and n.template_key <> 'help'
              and (n.visit_id is not null or private.is_member_phone(n.recipient_ref, n.org_id))
              then private.sms_compose(t.body, t.locale) else t.body end,
         (case when n.category = 'marketing' then
              base.vars || jsonb_build_object('org_legal_name', o.legal_name, 'org_postal_address', o.postal_address)
              else base.vars end) || jsonb_build_object('org_hide_product_branding', o.hide_product_branding),
         case when n.channel = 'push' then
                (select jsonb_build_object('kind', 'push', 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)
                 from app.push_subscriptions s where s.id = n.recipient_ref)
              when a.value is not null then jsonb_build_object('kind', 'address', 'value', a.value)
         end,
         -- A push subscription is its own opt-in, and account mail is part of the service the
         -- member signed up for; other channels need the latest consent granted.
         n.channel = 'push' or (n.visit_id is null and n.appointment_id is null)
           -- Decision 20 (#398): an email typed at join consents to transactional mail about
           -- that visit only. The visit row (source, joined_at) is the record, and relevance ends
           -- it with the visit. SMS needs its own explicit consent (TCPA); marketing never rides.
           or (n.recipient_ref = coalesce(n.visit_id, n.appointment_id) and n.channel = 'email' and n.category = 'transactional')
           or coalesce((select c.status = 'granted' and c.revoked_at is null
                        from app.consents c where c.id = n.consent_id), false),
         n.channel <> 'push' and (
           -- The org's own list, plus bounces and complaints from any org: the address is dead
           -- or unwilling everywhere.
           exists (select 1 from app.suppressions sp
                   where sp.channel = n.channel and private.canonical_email(sp.value) = private.canonical_email(a.value)
                     and (sp.org_id = n.org_id or sp.reason in ('bounce', 'complaint')))
           -- Guest messages per address across the platform, so joins at many venues with one
           -- typed address can't flood it. Rows other batches hold count too; rows in this
           -- batch don't, so one batch can overshoot.
           or (n.recipient_hash is not null and (
                 select count(*) from app.notifications s
                 where s.recipient_hash = n.recipient_hash and s.status in ('claimed', 'sent')
                   and s.updated_at > now() - interval '1 day') >= private.address_daily_cap())),
         l.tz, n.attempts,
         -- A visit's token is stored hashed, so no message can link to its status page. An appointment
         -- email gets a one-off manage link instead: minted here, stored only as a hash, shown nowhere
         -- but this return value. A retry mints another and keeps the first (it may already be in a delivered mail).
         case when n.channel = 'email' and n.appointment_id is not null and n.template_key like 'appointment\_%'
              then private.mint_manage_path(n.appointment_id, n.id) end
  from claimed n
  join app.organizations o on o.id = n.org_id
  cross join lateral (select private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)) a (value)
  -- Account mail has no visit or appointment, so no location time zone either.
  left join app.visits v on v.id = n.visit_id
  left join app.appointments ap on ap.id = n.appointment_id
  left join app.locations l on l.id = coalesce(v.location_id, ap.location_id)
  -- The business's name is not stored on the row, so the join confirmation said "us". Fill it here
  -- from the location; a value the row already carries (appointments set their own) wins.
  -- SMS text is made safe here, for every SMS row, whatever enqueued it (issue #1247).
  cross join lateral (select case when n.channel = 'sms'
                        then private.sms_safe_vars(jsonb_strip_nulls(jsonb_build_object('location_name', l.name)) || n.vars,
                                                   coalesce(v.locale, ap.locale, o.default_locale), o.name)
                        else jsonb_strip_nulls(jsonb_build_object('location_name', l.name)) || n.vars end) base (vars)
  left join lateral private.resolve_template(n.org_id, coalesce(v.queue_id, ap.queue_id), n.template_key, n.channel,
                                             coalesce(v.locale, ap.locale, o.default_locale)) t on true;
end $$;

-- ==================================================================== from 20261112080457_catalog_content_beauty.sql

-- T5 (#1299, tracker #1267): catalog content. Each row is supabase/catalog/<key>.json verbatim (key, version, tier, mode and
-- health_tagged also become columns); the file is the source, linted by scripts/check-templates.ts.
-- Published versions are immutable, so a content change is a new file version and a new migration.
-- Files: barber.json, hair_salon.json, nail_salon.json, spa.json.

insert into app.template_catalog (key, version, payload, tier, mode, health_tagged) values
  ('barber', 2, $catalog${"key":"barber","version":2,"tier":1,"mode":"both","health_tagged":false,"name":{"en":"Barber","es":"Barbería"},"description":{"en":"A walk-in line for cuts, fades and beards, with a line per barber and an \"Anyone available\" option.","es":"Una fila sin cita para cortes, degradados y barbas, con una fila por barbero y la opción \"Cualquiera disponible\"."},"keywords":{"en":["barber","barbershop","haircut","fade","beard","shave"],"es":["barbería","barbero","corte","degradado","barba","afeitado"]},"queues":[{"name":{"en":"Walk-ins","es":"Sin cita"},"prefix":"A","show_eta":true,"services":[{"name":{"en":"Haircut","es":"Corte de pelo"},"minutes":30},{"name":{"en":"Skin fade","es":"Degradado a piel"},"minutes":40},{"name":{"en":"Beard trim","es":"Arreglo de barba"},"minutes":15},{"name":{"en":"Haircut and beard","es":"Corte y barba"},"minutes":45},{"name":{"en":"Kids' cut (under 12)","es":"Corte infantil (menores de 12)"},"minutes":20},{"name":{"en":"Hot towel shave","es":"Afeitado con toalla caliente"},"minutes":30}]}],"resources":[{"label":{"en":"Chair 1","es":"Silla 1"},"kind":"chair"},{"label":{"en":"Chair 2","es":"Silla 2"},"kind":"chair"},{"label":{"en":"Chair 3","es":"Silla 3"},"kind":"chair"}],"providers":{"noun":{"en":"barber","es":"barbero"},"default_count":3,"pool":true},"form":{"name":{"en":"Before your cut","es":"Antes de tu corte"},"fields":[{"key":"style_notes","type":"short_text","label":{"en":"What are you getting today?","es":"¿Qué te vas a hacer hoy?"},"help":{"en":"For example \"number 2 on the sides, scissors on top\".","es":"Por ejemplo \"número 2 a los lados, tijera arriba\"."},"sensitivity":"normal"}]},"booking":{"slot_minutes":15,"buffer_after_minutes":5,"min_notice_minutes":30,"max_days_ahead":30}}$catalog$::jsonb, 1, 'both', false),
  ('hair_salon', 1, $catalog${"key":"hair_salon","version":1,"tier":1,"mode":"both","health_tagged":false,"name":{"en":"Hair salon","es":"Salón de belleza"},"description":{"en":"Cuts, blow-dries and colour, booked or walk-in, with a line per stylist and an \"Anyone available\" option.","es":"Cortes, peinados y color, con cita o sin cita, con una fila por estilista y la opción \"Cualquiera disponible\"."},"keywords":{"en":["hair salon","hairdresser","stylist","colour","color","blow-dry","highlights"],"es":["peluquería","salón","estilista","tinte","color","peinado","mechas"]},"queues":[{"name":{"en":"Salon","es":"Salón"},"prefix":"S","show_eta":true,"services":[{"name":{"en":"Cut and style","es":"Corte y peinado"},"minutes":45},{"name":{"en":"Clipper cut","es":"Corte con máquina"},"minutes":30},{"name":{"en":"Wash and blow-dry","es":"Lavado y secado"},"minutes":30},{"name":{"en":"Root colour","es":"Tinte de raíz"},"minutes":90},{"name":{"en":"Full colour","es":"Tinte completo"},"minutes":120},{"name":{"en":"Highlights","es":"Mechas"},"minutes":150}]}],"resources":[{"label":{"en":"Chair 1","es":"Silla 1"},"kind":"chair"},{"label":{"en":"Chair 2","es":"Silla 2"},"kind":"chair"},{"label":{"en":"Chair 3","es":"Silla 3"},"kind":"chair"},{"label":{"en":"Chair 4","es":"Silla 4"},"kind":"chair"}],"providers":{"noun":{"en":"stylist","es":"estilista"},"default_count":3,"pool":true},"form":{"name":{"en":"About your visit","es":"Sobre tu visita"},"fields":[{"key":"first_visit","type":"yes_no","label":{"en":"Is this your first visit with us?","es":"¿Es tu primera visita con nosotros?"},"sensitivity":"normal"},{"key":"hair_length","type":"single_choice","label":{"en":"How long is your hair now?","es":"¿Qué tan largo tienes el pelo ahora?"},"options":[{"en":"Short","es":"Corto"},{"en":"Medium","es":"Mediano"},{"en":"Long","es":"Largo"}],"sensitivity":"normal"},{"key":"style_notes","type":"short_text","label":{"en":"What would you like done?","es":"¿Qué te gustaría hacerte?"},"sensitivity":"normal"}]},"booking":{"slot_minutes":15,"buffer_after_minutes":10,"min_notice_minutes":60,"max_days_ahead":60}}$catalog$::jsonb, 1, 'both', false),
  ('nail_salon', 1, $catalog${"key":"nail_salon","version":1,"tier":1,"mode":"both","health_tagged":false,"name":{"en":"Nail salon","es":"Salón de uñas"},"description":{"en":"Manicures, pedicures and enhancements, booked or walk-in, with a line per nail technician and an \"Anyone available\" option.","es":"Manicuras, pedicuras y uñas postizas, con cita o sin cita, con una fila por manicurista y la opción \"Cualquiera disponible\"."},"keywords":{"en":["nail salon","nails","manicure","pedicure","gel","acrylic"],"es":["uñas","salón de uñas","manicura","pedicura","gel","acrílico"]},"queues":[{"name":{"en":"Nails","es":"Uñas"},"prefix":"N","show_eta":true,"services":[{"name":{"en":"Polish change","es":"Cambio de esmalte"},"minutes":15},{"name":{"en":"Manicure","es":"Manicura"},"minutes":30},{"name":{"en":"Gel manicure","es":"Manicura en gel"},"minutes":45},{"name":{"en":"Pedicure","es":"Pedicura"},"minutes":45},{"name":{"en":"Gel pedicure","es":"Pedicura en gel"},"minutes":60},{"name":{"en":"Acrylic full set","es":"Juego completo de acrílico"},"minutes":75},{"name":{"en":"Fill","es":"Relleno"},"minutes":45}]}],"resources":[{"label":{"en":"Nail station 1","es":"Mesa de uñas 1"},"kind":"desk"},{"label":{"en":"Nail station 2","es":"Mesa de uñas 2"},"kind":"desk"},{"label":{"en":"Nail station 3","es":"Mesa de uñas 3"},"kind":"desk"},{"label":{"en":"Pedicure chair 1","es":"Sillón de pedicura 1"},"kind":"chair"},{"label":{"en":"Pedicure chair 2","es":"Sillón de pedicura 2"},"kind":"chair"}],"providers":{"noun":{"en":"nail technician","es":"manicurista"},"default_count":3,"pool":true},"form":{"name":{"en":"Before your appointment","es":"Antes de tu servicio"},"fields":[{"key":"removal","type":"single_choice","label":{"en":"Do you need old product removed?","es":"¿Necesitas retirar producto anterior?"},"options":[{"en":"No","es":"No"},{"en":"Gel polish","es":"Esmalte en gel"},{"en":"Acrylic or hard gel","es":"Acrílico o gel duro"}],"sensitivity":"normal"},{"key":"design_notes","type":"short_text","label":{"en":"Colour or design ideas","es":"Ideas de color o diseño"},"sensitivity":"normal"}]},"booking":{"slot_minutes":15,"buffer_after_minutes":10,"min_notice_minutes":60,"max_days_ahead":30}}$catalog$::jsonb, 1, 'both', false),
  ('spa', 1, $catalog${"key":"spa","version":1,"tier":1,"mode":"both","health_tagged":false,"name":{"en":"Spa and massage","es":"Spa y masajes"},"description":{"en":"Massages, facials and body treatments, mostly booked, with a line per therapist and an \"Anyone available\" option.","es":"Masajes, faciales y tratamientos corporales, sobre todo con cita, con una fila por terapeuta y la opción \"Cualquiera disponible\"."},"keywords":{"en":["spa","massage","facial","wellness","body treatment","relaxation"],"es":["spa","masaje","facial","bienestar","tratamiento corporal","relajación"]},"queues":[{"name":{"en":"Treatments","es":"Tratamientos"},"prefix":"T","show_eta":true,"services":[{"name":{"en":"Massage, 30 minutes","es":"Masaje, 30 minutos"},"minutes":30},{"name":{"en":"Massage, 60 minutes","es":"Masaje, 60 minutos"},"minutes":60},{"name":{"en":"Massage, 90 minutes","es":"Masaje, 90 minutos"},"minutes":90},{"name":{"en":"Facial","es":"Facial"},"minutes":60},{"name":{"en":"Body scrub","es":"Exfoliación corporal"},"minutes":45}]}],"resources":[{"label":{"en":"Room 1","es":"Sala 1"},"kind":"room"},{"label":{"en":"Room 2","es":"Sala 2"},"kind":"room"},{"label":{"en":"Room 3","es":"Sala 3"},"kind":"room"}],"providers":{"noun":{"en":"therapist","es":"terapeuta"},"default_count":3,"pool":true},"form":{"name":{"en":"Before your treatment","es":"Antes de tu tratamiento"},"fields":[{"key":"pressure","type":"single_choice","label":{"en":"Preferred pressure","es":"Presión preferida"},"options":[{"en":"Light","es":"Suave"},{"en":"Medium","es":"Media"},{"en":"Firm","es":"Firme"}],"sensitivity":"normal"},{"key":"avoid_areas","type":"short_text","label":{"en":"Any injuries or areas to avoid?","es":"¿Alguna lesión o zona que debamos evitar?"},"help":{"en":"Keep it short, for example \"sore left shoulder\". Please don't include medical history.","es":"Sé breve, por ejemplo \"hombro izquierdo adolorido\". No incluyas tu historial médico."},"sensitivity":"sensitive"}]},"booking":{"slot_minutes":15,"buffer_after_minutes":15,"min_notice_minutes":120,"max_days_ahead":60}}$catalog$::jsonb, 1, 'both', false);

-- ==================================================================== from 20261112081530_template_providers.sql

-- T4 (#1298, tracker #1267): provider-count setup. "How many doctors? 3" makes one personal line per
-- named provider, plus an optional "Anyone available" pool their call_next falls back to (M4), each with
-- the template's services, and the template's form copied once into the library and attached to every
-- line, all in the one apply transaction. Also reads T2 content ({en, es} strings, a form block).
--
-- Interface (rule 1): api.apply_industry_template gains two defaulted, appended parameters
-- (p_providers text[] default null, p_pool boolean default false). Existing three-argument callers are
-- unchanged and get the old behaviour plus the form and booking copy.
-- Alternatives (rule 7): a separate api.apply_provider_template RPC (rejected: a second entry point
-- that duplicates numbering, idempotency, health tagging and copy rules) vs appending defaulted
-- parameters to the one apply function (chosen). Booking settings in the payload are not copied yet:
-- their shape lands with the T5-T8 content.
--
-- redefines api.apply_industry_template from the catalog_localized_reads section above: appends p_providers, p_pool

-- A catalog form's fields in the forms engine's shape: localized label, help, body and options become text.
create function private.catalog_form_fields(p_fields jsonb, p_lang text default 'en') returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(
           f || jsonb_build_object(
             'label', private.catalog_text(f -> 'label', p_lang),
             'help', private.catalog_text(f -> 'help', p_lang),
             'body', private.catalog_text(f -> 'body', p_lang),
             'options', (select jsonb_agg(private.catalog_text(o, p_lang) order by n)
                         from jsonb_array_elements(f -> 'options') with ordinality x(o, n)
                         where jsonb_typeof(f -> 'options') = 'array')))
         order by ord), '[]'::jsonb)
  from jsonb_array_elements(p_fields) with ordinality t(f, ord)
  where jsonb_typeof(p_fields) = 'array'
$$;
comment on function private.catalog_form_fields(jsonb, text) is
  'A catalog form field list with every localized string resolved to p_lang, ready for app.form_versions.fields.';
revoke all on function private.catalog_form_fields(jsonb, text) from public, anon, authenticated;

-- The first ticket prefix (A to Z, then AA to ZZ) no active line in the location uses.
create function private.free_queue_prefix(p_location_id uuid) returns text
language sql stable set search_path = '' as $$
  select p from (
    select chr(65 + a) as p, a as ord from generate_series(0, 25) a
    union all
    select chr(65 + a) || chr(65 + b), 26 + a * 26 + b from generate_series(0, 25) a, generate_series(0, 25) b
  ) c
  where not exists (select 1 from app.queues q
                    where q.location_id = p_location_id and q.archived_at is null and q.ticket_prefix = c.p)
  order by c.ord limit 1
$$;
comment on function private.free_queue_prefix(uuid) is
  'The first ticket prefix (A..Z, then AA..ZZ) that no active line of the location uses.';
revoke all on function private.free_queue_prefix(uuid) from public, anon, authenticated;

drop function api.apply_industry_template(uuid, text, uuid);
create function api.apply_industry_template(
  p_location_id uuid, p_template_key text, p_idempotency_key uuid,
  p_providers text[] default null, p_pool boolean default false
)
returns api.template_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  loc app.locations;
  tpl jsonb;
  v_version int;
  claim record;
  q jsonb;
  s jsonb;
  r jsonb;
  v_queue app.queues;
  v_pool app.queues;
  v_lines uuid[] := '{}';
  v_line uuid;
  v_name text;
  v_services jsonb;
  v_form app.forms;
  v_form_name text;
  v_mode text;
  v_service uuid;
  result api.template_result;
begin
  select * into loc from app.locations l where l.id = p_location_id;
  if not found or not private.has_role(loc.org_id, loc.id, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_role(loc.org_id, loc.id, 'admin') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  -- The newest catalog version; the rows created below are copies that later versions never touch.
  select c.payload || jsonb_build_object('health_tagged', c.health_tagged), c.version, c.mode
  into tpl, v_version, v_mode
  from app.template_catalog c
  where c.key = p_template_key order by c.version desc limit 1;
  if tpl is null or p_idempotency_key is null then raise exception 'not_found'; end if;
  -- Providers: 1 to 20 distinct names of 1 to 80 characters (the owner names each personal line).
  if p_providers is not null and (
       cardinality(p_providers) not between 1 and 20
       or exists (select 1 from unnest(p_providers) n where n is null or length(btrim(n)) not between 1 and 80)
       or (select count(distinct lower(btrim(n))) from unnest(p_providers) n) <> cardinality(p_providers)) then
    raise exception 'invalid_input' using detail = 'providers';
  end if;

  select * into claim from private.claim_idempotent(loc.org_id, 'apply_industry_template', p_idempotency_key);
  if claim.replay then
    if claim.response ->> 'template_key' is distinct from p_template_key then
      raise exception 'invalid_input'; -- the key was used for a different template
    end if;
    return jsonb_populate_record(null::api.template_result, claim.response);
  end if;
  if exists (select 1 from app.visits v
             where v.location_id = loc.id and v.service_day = private.service_day(loc.id)) then
    raise exception 'invalid_input' using detail = 'location_has_visits';
  end if;

  result := row(p_template_key, 0, 0, 0);
  if (tpl ->> 'health_tagged')::boolean then
    -- The tag covers the whole organization, so it needs an org-wide admin, not one scoped to a place.
    if not private.has_role(loc.org_id, null, 'admin') then
      raise exception 'permission_denied' using errcode = '42501';
    end if;
    update app.locations set display_names_enabled = false where org_id = loc.org_id and display_names_enabled;
    update app.organizations set health_tagged = true where id = loc.org_id;
  end if;

  if p_providers is null then
    for q in select * from jsonb_array_elements(tpl -> 'queues') loop
      -- Applying again, or after hand-made setup, never duplicates a queue of the same name.
      v_name := private.catalog_text(q -> 'name');
      select * into v_queue from app.queues x
      where x.location_id = loc.id and x.archived_at is null and x.name = v_name;
      if not found then
        insert into app.queues (org_id, location_id, name, ticket_prefix, show_eta,
                                party_size_enabled, party_size_min, party_size_max,
                                origin_template, origin_version)
        values (loc.org_id, loc.id, v_name, q ->> 'prefix', (q ->> 'show_eta')::boolean,
                q ? 'party_max', coalesce((q ->> 'party_min')::int, 1), coalesce((q ->> 'party_max')::int, 1),
                p_template_key, v_version)
        returning * into v_queue;
        result.queues_created := result.queues_created + 1;
      end if;
      v_lines := v_lines || v_queue.id;
      for s in select * from jsonb_array_elements(q -> 'services') loop
        if not exists (select 1 from app.services x
                       where x.queue_id = v_queue.id and x.name = private.catalog_text(s -> 'name')) then
          insert into app.services (org_id, location_id, queue_id, name, expected_minutes, ticket_prefix)
          values (loc.org_id, loc.id, v_queue.id, private.catalog_text(s -> 'name'), (s ->> 'minutes')::int, s ->> 'prefix')
          returning id into v_service;
          if v_mode in ('booking', 'both') and jsonb_typeof(tpl -> 'booking') = 'object'
             and s -> 'bookable' is distinct from 'false'::jsonb then
            insert into app.booking_policies (org_id, location_id, service_id, bookable, slot_minutes,
                                              buffer_after_minutes, min_notice_minutes, max_days_ahead)
            values (loc.org_id, loc.id, v_service, true,
                    coalesce((tpl -> 'booking' ->> 'slot_minutes')::int, 30),
                    coalesce((tpl -> 'booking' ->> 'buffer_after_minutes')::int, 0),
                    coalesce((tpl -> 'booking' ->> 'min_notice_minutes')::int, 60),
                    coalesce((tpl -> 'booking' ->> 'max_days_ahead')::int, 30))
            on conflict (service_id) do nothing;
          end if;
          result.services_created := result.services_created + 1;
        end if;
      end loop;
    end loop;
  else
    -- One personal line per provider, plus the optional pool; every line offers all the template's
    -- services (first occurrence of each name) and takes its ETA and party settings from the first queue.
    q := tpl -> 'queues' -> 0;
    select coalesce(jsonb_agg(x.s order by x.ord), '[]') into v_services
    from (select distinct on (private.catalog_text(e.s -> 'name')) e.s, e.ord
          from (select sv.s, qi.n * 1000 + sv.n as ord
                from jsonb_array_elements(tpl -> 'queues') with ordinality qi(qq, n),
                     jsonb_array_elements(qi.qq -> 'services') with ordinality sv(s, n)) e
          order by private.catalog_text(e.s -> 'name'), e.ord) x;
    if p_pool then
      select * into v_pool from app.queues x
      where x.location_id = loc.id and x.archived_at is null and x.kind = 'pool' order by x.created_at limit 1;
      if not found then
        v_name := 'Anyone available';
        if exists (select 1 from app.queues x where x.location_id = loc.id and x.archived_at is null and x.name = v_name) then
          raise exception 'invalid_input' using detail = 'pool_name_taken';
        end if;
        insert into app.queues (org_id, location_id, name, kind, ticket_prefix, show_eta,
                                party_size_enabled, party_size_min, party_size_max, origin_template, origin_version)
        values (loc.org_id, loc.id, v_name, 'pool', private.free_queue_prefix(loc.id),
                coalesce((q ->> 'show_eta')::boolean, true), q ? 'party_max',
                coalesce((q ->> 'party_min')::int, 1), coalesce((q ->> 'party_max')::int, 1), p_template_key, v_version)
        returning * into v_pool;
        result.queues_created := result.queues_created + 1;
      end if;
      v_lines := v_lines || v_pool.id;
    end if;
    foreach v_name in array p_providers loop
      v_name := btrim(v_name);
      select * into v_queue from app.queues x
      where x.location_id = loc.id and x.archived_at is null and x.name = v_name;
      if not found then
        insert into app.queues (org_id, location_id, name, kind, pulls_from, ticket_prefix, show_eta,
                                party_size_enabled, party_size_min, party_size_max, origin_template, origin_version)
        values (loc.org_id, loc.id, v_name, 'provider', v_pool.id, private.free_queue_prefix(loc.id),
                coalesce((q ->> 'show_eta')::boolean, true), q ? 'party_max',
                coalesce((q ->> 'party_min')::int, 1), coalesce((q ->> 'party_max')::int, 1), p_template_key, v_version)
        returning * into v_queue;
        result.queues_created := result.queues_created + 1;
      elsif v_queue.kind = 'provider' and v_queue.pulls_from is null and v_pool.id is not null then
        -- Re-applying with the pool turned on connects the existing personal lines to it.
        update app.queues set pulls_from = v_pool.id where id = v_queue.id;
      end if;
      v_lines := v_lines || v_queue.id;
    end loop;
    foreach v_line in array v_lines loop
      for s in select * from jsonb_array_elements(v_services) loop
        if not exists (select 1 from app.services x
                       where x.queue_id = v_line and x.name = private.catalog_text(s -> 'name')) then
          insert into app.services (org_id, location_id, queue_id, name, expected_minutes, ticket_prefix)
          values (loc.org_id, loc.id, v_line, private.catalog_text(s -> 'name'), (s ->> 'minutes')::int, s ->> 'prefix')
          returning id into v_service;
          if v_mode in ('booking', 'both') and jsonb_typeof(tpl -> 'booking') = 'object'
             and s -> 'bookable' is distinct from 'false'::jsonb then
            insert into app.booking_policies (org_id, location_id, service_id, bookable, slot_minutes,
                                              buffer_after_minutes, min_notice_minutes, max_days_ahead)
            values (loc.org_id, loc.id, v_service, true,
                    coalesce((tpl -> 'booking' ->> 'slot_minutes')::int, 30),
                    coalesce((tpl -> 'booking' ->> 'buffer_after_minutes')::int, 0),
                    coalesce((tpl -> 'booking' ->> 'min_notice_minutes')::int, 60),
                    coalesce((tpl -> 'booking' ->> 'max_days_ahead')::int, 30))
            on conflict (service_id) do nothing;
          end if;
          result.services_created := result.services_created + 1;
        end if;
      end loop;
    end loop;
  end if;

  for r in select * from jsonb_array_elements(tpl -> 'resources') loop
    if not exists (select 1 from app.counters x
                   where x.location_id = loc.id and x.archived_at is null and x.label = private.catalog_text(r -> 'label')) then
      insert into app.counters (org_id, location_id, label, kind, seats)
      values (loc.org_id, loc.id, private.catalog_text(r -> 'label'), (r ->> 'kind')::app.resource_kind, (r ->> 'seats')::int);
      result.counters_created := result.counters_created + 1;
    end if;
  end loop;

  -- The template's form: one library copy, attached to every line in this one action. Applying again
  -- reuses the copy of the same name. A full library (3 forms), or an agreement before the business has
  -- a privacy contact, leaves the setup without the form (or with it as a draft) rather than failing it.
  if jsonb_typeof(tpl -> 'form') = 'object' then
    v_form_name := left(btrim(private.catalog_text(tpl -> 'form' -> 'name')), 80);
    select * into v_form from app.forms f
    where f.location_id = loc.id and not f.is_queue_default and f.name = v_form_name;
    if not found then
      begin
        perform private.validate_form_fields(private.catalog_form_fields(tpl -> 'form' -> 'fields'));
        insert into app.forms (org_id, location_id, name, origin_template, origin_version)
        values (loc.org_id, loc.id, v_form_name, p_template_key, v_version)
        returning * into v_form;
        insert into app.form_versions (org_id, location_id, form_id, version, fields)
        values (loc.org_id, loc.id, v_form.id, 1, private.catalog_form_fields(tpl -> 'form' -> 'fields'));
      exception when raise_exception then
        v_form := null;
      end;
      if v_form.id is not null then
        begin
          update app.form_versions set published_at = now() where form_id = v_form.id and published_at is null;
          update app.forms set status = 'published' where id = v_form.id;
          v_form.status := 'published';
        exception when raise_exception then
          null; -- stays a draft until the owner records a privacy contact and publishes it
        end;
      end if;
    end if;
    if v_form.status = 'published' then
      insert into app.form_targets (org_id, location_id, form_id, queue_id, channel)
      select loc.org_id, loc.id, v_form.id, l, 'any' from unnest(v_lines) l
      on conflict (queue_id, channel) where queue_id is not null do nothing;
    end if;
  end if;

  perform private.save_idempotent('apply_industry_template', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.apply_industry_template(uuid, text, uuid, text[], boolean) is
  'Creates the template''s queues, services and counters in the location, skipping any with the '
  'same name already there. With p_providers (1 to 20 distinct names), creates one personal line '
  '(kind provider) per name instead of the template''s queues, each offering all the template''s '
  'services; with p_pool also an "Anyone available" pool the providers fall back to. The template''s '
  'form is copied once into the location''s library and attached to every line it set up (left as a '
  'draft while an agreement needs a privacy contact; skipped when the library is full). Owner or '
  'admin of the location; refuses (invalid_input, detail location_has_visits) when the location '
  'already has visits in the current service day. A clinic template tags the organization '
  'health_tagged and turns names off on displays for good. Raises not_found (unknown template or a '
  'location the caller cannot see), permission_denied (42501, a member below admin), invalid_input '
  '(detail providers: a bad provider list). Idempotent per key, and applying again never duplicates. '
  'Uses the newest catalog version and stamps origin_template and origin_version on what it creates. '
  'Implemented by 2A-ORG4, T1 (#1295), T4 (#1298).';
revoke all on function api.apply_industry_template(uuid, text, uuid, text[], boolean) from public, anon;
grant execute on function api.apply_industry_template(uuid, text, uuid, text[], boolean) to authenticated, service_role;

-- ==================================================================== from 20261112082637_recent_texts.sql

-- T4 (#1239): "Recent texts" for shops, so an owner or manager can answer "did my customer get it?" without
-- asking support. One row per text message of the location, newest first, with a plain outcome the database
-- decides and the number masked to its last two digits. No body, no variables, no full number (I-13).
--
-- Interface: a new read, api.list_recent_texts. Alternatives considered: (a) widen api.list_failed_notifications
-- with delivered rows and a masked number. Rejected: fixed return type (api.notification_status) with no
-- recipient field, and the console's warning logic reads it as "failed only". (b) let the page map
-- notification status, delivery status and error code to an outcome. Rejected: the outcome rules (what counts
-- as blocked by STOP or held for quiet hours) would live in TypeScript (rule 2).

create type api.recent_text as (
  id uuid,
  created_at timestamptz,
  template text,
  -- delivered | sent (no receipt yet) | sending | quiet_hours | blocked_stop | not_sent | failed
  outcome text,
  -- why it was not sent or failed: the error code, for the page to word (null otherwise)
  reason text,
  -- last two digits of the number, e.g. '23'; null when the contact is gone
  number_hint text,
  -- the ticket of the visit, so staff can match it to a guest
  ticket text
);

create function private.text_outcome(n app.notifications) returns text
language sql stable set search_path = '' as $$
  select case
    when n.status = 'sent' and n.delivery_status = 'delivered' then 'delivered'
    when n.status = 'sent' and n.delivery_status in ('undelivered', 'failed') then 'failed'
    when n.status = 'sent' then 'sent'
    when n.status = 'dead' then 'failed'
    when n.status = 'suppressed' and n.error_code = 'suppressed' then 'blocked_stop'
    when n.status = 'suppressed' then 'not_sent'
    when n.status = 'queued' and n.quiet_hours_deferred and n.next_attempt_at > now() then 'quiet_hours'
    else 'sending'
  end
$$;
revoke all on function private.text_outcome(app.notifications) from public, anon, authenticated;
comment on function private.text_outcome(app.notifications) is
  'The outcome a shop sees for one text: delivered, sent (no receipt yet), sending, quiet_hours (held until the '
  'send window opens), blocked_stop (the guest replied STOP), not_sent (no consent, channel off, ...) or failed.';

create function api.list_recent_texts(p_location_id uuid, p_before timestamptz default null)
returns setof api.recent_text
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
begin
  select * into l from app.locations where id = p_location_id;
  if not found or not private.has_role(l.org_id, l.id, 'manager') then
    raise exception 'not_found';
  end if;
  return query
    select n.id, n.created_at, n.template_key, private.text_outcome(n),
           case when n.status in ('suppressed', 'dead') or n.delivery_status in ('undelivered', 'failed')
                then n.error_code end,
           right(gc.value, 2), v.display_ticket
    from app.notifications n
    join app.visits v on v.id = n.visit_id and v.org_id = n.org_id
    left join app.guest_contacts gc on gc.org_id = n.org_id and gc.id = n.recipient_ref and gc.channel = 'phone'
    where n.org_id = l.org_id and v.location_id = l.id and n.channel = 'sms'
      and n.created_at > now() - interval '7 days'
      and (p_before is null or n.created_at < p_before)
    order by n.created_at desc, n.id
    limit 50;
end $$;
comment on function api.list_recent_texts(uuid, timestamptz) is
  'Managers and above of the location: its text messages of the last 7 days, newest first, 50 a page (pass the '
  'last created_at as p_before for the next). Each has the template, an outcome (private.text_outcome), the '
  'error code when not sent or failed, the last two digits of the number and the visit''s ticket. Never the '
  'body or the full number. Raises not_found for an unknown location or one the caller does not manage '
  '(also across tenants).';
revoke all on function api.list_recent_texts(uuid, timestamptz) from public, anon;
grant execute on function api.list_recent_texts(uuid, timestamptz) to authenticated;


-- ==================================================================== from 20261112083209_sms_footer_es_help.sql

-- C3 (#1229): one wording for STOP and HELP, in the opt-in text and in every text.
-- The Spanish footer said "AYUDA para ayuda", but the Spanish opt-in text (app.consent_texts es v1), the opt-in page,
-- the Privacy Policy and the inbound keyword list (private.inbound_keyword_kind: HELP, INFO) all use HELP, and no
-- provider route treats AYUDA as a help request. A guest who followed the footer got no answer. Footer v2 uses HELP.
-- The opt-in texts are unchanged; supabase/tests/consent/consent_footer.test.sql now fails the build when the latest
-- opt-in text for a language stops containing that language's latest footer, so the two cannot drift again.
-- Alternative rejected: add AYUDA to the help keywords (a keyword change on every inbound route, while carriers and
-- Twilio's own handling key on HELP; the opt-in text already says HELP).
insert into app.sms_footers (locale, version, text) values
  ('es', 2, 'Responde STOP para cancelar, HELP para ayuda.');

-- ==================================================================== from 20261112084155_catalog_content_animals_studio_clinic.sql

-- T6 (#1300, tracker #1267): catalog content. Each row is supabase/catalog/<key>.json verbatim (key, version, tier, mode and
-- health_tagged also become columns); the file is the source, linted by scripts/check-templates.ts.
-- Published versions are immutable, so a content change is a new file version and a new migration.
-- Files: tattoo_piercing.json, pet_groomer.json, veterinary.json, walk_in_clinic.json.

insert into app.template_catalog (key, version, payload, tier, mode, health_tagged) values
  ('tattoo_piercing', 1, $catalog${"key":"tattoo_piercing","version":1,"tier":1,"mode":"both","health_tagged":false,"name":{"en":"Tattoo and piercing studio","es":"Estudio de tatuajes y perforaciones"},"description":{"en":"Flash walk-ins and booked sessions, with age confirmation, a consent and aftercare waiver, and a line per artist.","es":"Diseños sin cita y sesiones con cita, con confirmación de edad, un consentimiento con cuidados posteriores y una fila por artista."},"keywords":{"en":["tattoo","piercing","flash","ink","studio","body art"],"es":["tatuaje","perforación","piercing","flash","estudio","arte corporal"]},"queues":[{"name":{"en":"Studio","es":"Estudio"},"prefix":"T","show_eta":true,"services":[{"name":{"en":"Consultation","es":"Consulta"},"minutes":15},{"name":{"en":"Flash tattoo","es":"Tatuaje flash"},"minutes":60},{"name":{"en":"Custom tattoo session","es":"Sesión de tatuaje personalizado"},"minutes":180},{"name":{"en":"Touch-up","es":"Retoque"},"minutes":30},{"name":{"en":"Ear piercing","es":"Perforación de oreja"},"minutes":15},{"name":{"en":"Body piercing","es":"Perforación corporal"},"minutes":20}]}],"resources":[{"label":{"en":"Station 1","es":"Estación 1"},"kind":"chair"},{"label":{"en":"Station 2","es":"Estación 2"},"kind":"chair"},{"label":{"en":"Station 3","es":"Estación 3"},"kind":"chair"}],"providers":{"noun":{"en":"artist","es":"artista"},"default_count":3,"pool":true},"form":{"name":{"en":"Tattoo and piercing consent","es":"Consentimiento para tatuaje y perforación"},"fields":[{"key":"piece","type":"short_text","label":{"en":"What are you getting?","es":"¿Qué te vas a hacer?"},"help":{"en":"For example \"small flash on forearm\" or \"helix piercing\".","es":"Por ejemplo \"flash pequeño en el antebrazo\" o \"perforación en el hélix\"."},"sensitivity":"normal"},{"key":"yes_no_1","type":"yes_no","label":{"en":"Are you 18 or older?","es":"¿Tienes 18 años o más?"},"required":true,"must_be_true":true},{"key":"agreement_1","type":"agreement","label":{"en":"Consent to the procedure","es":"Consentimiento para el procedimiento"},"body":{"en":"I am asking this studio to give me a tattoo or piercing. Before starting I confirm that:\n\n- I have told the artist about anything that could affect the procedure or healing, such as allergies, skin conditions, medicines that affect bleeding, or pregnancy.\n- I have not had alcohol or drugs today that could affect my judgement or bleeding.\n- I understand that a tattoo or piercing breaks the skin and can cause pain, swelling, bleeding, infection, allergic reaction or scarring.\n- I understand that colours, lines and healing vary from person to person, and that a tattoo is permanent and hard to remove.\n- I have checked the design, spelling and placement, and I approve them.\n\nI can ask questions or stop at any time. I agree that the studio and its artists are not responsible for problems caused by information I did not share or by aftercare I did not follow.","es":"Le pido a este estudio que me haga un tatuaje o una perforación. Antes de empezar confirmo que:\n\n- Le he contado al artista cualquier cosa que pueda afectar el procedimiento o la cicatrización, como alergias, problemas de la piel, medicamentos que afecten el sangrado o un embarazo.\n- Hoy no he consumido alcohol ni drogas que puedan afectar mi juicio o el sangrado.\n- Entiendo que un tatuaje o una perforación rompe la piel y puede causar dolor, hinchazón, sangrado, infección, reacción alérgica o cicatrices.\n- Entiendo que los colores, las líneas y la cicatrización varían de una persona a otra, y que un tatuaje es permanente y difícil de quitar.\n- He revisado el diseño, la ortografía y la ubicación, y los apruebo.\n\nPuedo hacer preguntas o detenerme en cualquier momento. Acepto que el estudio y sus artistas no son responsables de problemas causados por información que no compartí o por cuidados posteriores que no seguí."},"required":true},{"key":"agreement_2","type":"agreement","label":{"en":"Aftercare","es":"Cuidados posteriores"},"body":{"en":"I have received aftercare instructions and I will follow them. In particular I will:\n\n- Keep the area clean and wash my hands before touching it.\n- Avoid swimming, baths and direct sun until it has healed.\n- Not pick or scratch scabs.\n\nIf I see signs of infection, such as spreading redness, heat, pus or fever, I will contact a health professional and let the studio know.","es":"He recibido las instrucciones de cuidado y las seguiré. En particular:\n\n- Mantendré la zona limpia y me lavaré las manos antes de tocarla.\n- Evitaré nadar, bañarme en tina y el sol directo hasta que cicatrice.\n- No me quitaré ni rascaré las costras.\n\nSi veo señales de infección, como enrojecimiento que se extiende, calor, pus o fiebre, consultaré a un profesional de la salud y avisaré al estudio."},"required":true},{"key":"signature_1","type":"signature","label":{"en":"Type your full name to sign","es":"Escribe tu nombre completo para firmar"},"required":true}]},"waiver_banner":{"en":"A starting point, not legal advice. Have your own counsel review before using.","es":"Un punto de partida, no asesoría legal. Pide a tu propio abogado que lo revise antes de usarlo."},"booking":{"slot_minutes":30,"buffer_after_minutes":15,"min_notice_minutes":1440,"max_days_ahead":90}}$catalog$::jsonb, 1, 'both', false),
  ('pet_groomer', 1, $catalog${"key":"pet_groomer","version":1,"tier":1,"mode":"both","health_tagged":false,"name":{"en":"Pet groomer","es":"Peluquería de mascotas"},"description":{"en":"Baths, full grooms and nail trims, booked or walk-in, with a line per groomer and an \"Anyone available\" option.","es":"Baños, cortes completos y corte de uñas, con cita o sin cita, con una fila por peluquero y la opción \"Cualquiera disponible\"."},"keywords":{"en":["pet groomer","dog grooming","cat grooming","pet salon","nail trim","bath"],"es":["peluquería canina","mascotas","grooming","baño de perro","corte de uñas","gatos"]},"queues":[{"name":{"en":"Grooming","es":"Peluquería"},"prefix":"G","show_eta":true,"services":[{"name":{"en":"Nail trim","es":"Corte de uñas"},"minutes":15},{"name":{"en":"Bath and brush, small dog","es":"Baño y cepillado, perro pequeño"},"minutes":60},{"name":{"en":"Bath and brush, large dog","es":"Baño y cepillado, perro grande"},"minutes":90},{"name":{"en":"Full groom, small dog","es":"Corte completo, perro pequeño"},"minutes":90},{"name":{"en":"Full groom, large dog","es":"Corte completo, perro grande"},"minutes":120},{"name":{"en":"Cat groom","es":"Arreglo de gato"},"minutes":90}]}],"resources":[{"label":{"en":"Grooming table 1","es":"Mesa de peluquería 1"},"kind":"table"},{"label":{"en":"Grooming table 2","es":"Mesa de peluquería 2"},"kind":"table"}],"providers":{"noun":{"en":"groomer","es":"peluquero"},"default_count":2,"pool":true},"form":{"name":{"en":"About your pet","es":"Sobre tu mascota"},"fields":[{"key":"pet_name","type":"short_text","label":{"en":"Pet's name","es":"Nombre de tu mascota"},"sensitivity":"normal"},{"key":"breed","type":"short_text","label":{"en":"Breed or type","es":"Raza o tipo"},"sensitivity":"normal"},{"key":"handling","type":"short_text","label":{"en":"Anything we should know?","es":"¿Algo que debamos saber?"},"help":{"en":"For example \"nervous with dryers\" or \"matted behind the ears\".","es":"Por ejemplo \"se pone nervioso con el secador\" o \"nudos detrás de las orejas\"."},"sensitivity":"normal"}]},"booking":{"slot_minutes":30,"buffer_after_minutes":15,"min_notice_minutes":120,"max_days_ahead":60}}$catalog$::jsonb, 1, 'both', false),
  ('veterinary', 1, $catalog${"key":"veterinary","version":1,"tier":1,"mode":"both","health_tagged":true,"name":{"en":"Veterinary clinic","es":"Clínica veterinaria"},"description":{"en":"Exams, vaccines and sick visits, booked or walk-in, with a line per veterinarian. Ticket numbers only on screens.","es":"Consultas, vacunas y visitas por enfermedad, con cita o sin cita, con una fila por veterinario. Solo números en las pantallas."},"keywords":{"en":["vet","veterinary","animal hospital","pet clinic","vaccines"],"es":["veterinaria","veterinario","clínica veterinaria","mascotas","vacunas"]},"queues":[{"name":{"en":"Reception","es":"Recepción"},"prefix":"V","show_eta":true,"services":[{"name":{"en":"Wellness exam","es":"Revisión general"},"minutes":30},{"name":{"en":"Vaccines","es":"Vacunas"},"minutes":15},{"name":{"en":"Sick or injured pet","es":"Mascota enferma o herida"},"minutes":30},{"name":{"en":"Follow-up","es":"Seguimiento"},"minutes":15},{"name":{"en":"Nail trim","es":"Corte de uñas"},"minutes":10}]}],"resources":[{"label":{"en":"Exam room 1","es":"Consultorio 1"},"kind":"room"},{"label":{"en":"Exam room 2","es":"Consultorio 2"},"kind":"room"}],"providers":{"noun":{"en":"veterinarian","es":"veterinario"},"default_count":2,"pool":true},"form":{"name":{"en":"About your pet","es":"Sobre tu mascota"},"fields":[{"key":"pet_name","type":"short_text","label":{"en":"Pet's name","es":"Nombre de tu mascota"},"sensitivity":"normal"},{"key":"species","type":"single_choice","label":{"en":"Species","es":"Especie"},"options":[{"en":"Dog","es":"Perro"},{"en":"Cat","es":"Gato"},{"en":"Other","es":"Otra"}],"sensitivity":"normal"},{"key":"reason","type":"short_text","label":{"en":"Reason for the visit, in a few words","es":"Motivo de la visita, en pocas palabras"},"help":{"en":"For example \"limping\" or \"annual vaccines\". The vet will ask for details.","es":"Por ejemplo \"cojea\" o \"vacunas anuales\". El veterinario te pedirá los detalles."},"sensitivity":"sensitive"}]},"booking":{"slot_minutes":15,"buffer_after_minutes":5,"min_notice_minutes":60,"max_days_ahead":60}}$catalog$::jsonb, 1, 'both', true),
  ('walk_in_clinic', 1, $catalog${"key":"walk_in_clinic","version":1,"tier":1,"mode":"walk_in","health_tagged":true,"name":{"en":"Walk-in clinic","es":"Clínica sin cita"},"description":{"en":"A walk-in line with a line per doctor and an \"Anyone available\" pool. Ticket numbers only on screens; no visit details in messages.","es":"Una fila sin cita con una fila por médico y un grupo \"Cualquiera disponible\". Solo números en las pantallas; ningún detalle de la visita en los mensajes."},"keywords":{"en":["walk-in clinic","medical clinic","doctor","urgent","family doctor","health"],"es":["clínica","médico","consulta sin cita","doctor","salud","atención médica"]},"queues":[{"name":{"en":"Walk-in","es":"Sin cita"},"prefix":"C","show_eta":true,"services":[{"name":{"en":"Walk-in visit","es":"Consulta sin cita"},"minutes":15},{"name":{"en":"Follow-up","es":"Seguimiento"},"minutes":10},{"name":{"en":"Forms and notes","es":"Formularios y justificantes"},"minutes":10}]}],"resources":[{"label":{"en":"Room 1","es":"Consultorio 1"},"kind":"room"},{"label":{"en":"Room 2","es":"Consultorio 2"},"kind":"room"},{"label":{"en":"Room 3","es":"Consultorio 3"},"kind":"room"}],"providers":{"noun":{"en":"doctor","es":"médico"},"default_count":3,"pool":true},"form":{"name":{"en":"Before your visit","es":"Antes de tu consulta"},"fields":[{"key":"returning","type":"yes_no","label":{"en":"Have you been to this clinic before?","es":"¿Has venido antes a esta clínica?"},"sensitivity":"normal"},{"key":"reason","type":"short_text","label":{"en":"Reason for the visit, in a few words","es":"Motivo de la consulta, en pocas palabras"},"help":{"en":"For example \"sore throat\". Please don't include medical history; the doctor will ask.","es":"Por ejemplo \"dolor de garganta\". No incluyas tu historial médico; el médico te preguntará."},"sensitivity":"sensitive"}]}}$catalog$::jsonb, 1, 'walk_in', true);

-- ==================================================================== from 20261112085746_catalog_content_health.sql

-- T7 (#1301, tracker #1267): catalog content. Each row is supabase/catalog/<key>.json verbatim (key, version, tier, mode and
-- health_tagged also become columns); the file is the source, linted by scripts/check-templates.ts.
-- Published versions are immutable, so a content change is a new file version and a new migration.
-- Files: family_practice.json, dental.json, physio_chiro.json, pharmacy.json.

insert into app.template_catalog (key, version, payload, tier, mode, health_tagged) values
  ('family_practice', 1, $catalog${"key":"family_practice","version":1,"tier":1,"mode":"both","health_tagged":true,"name":{"en":"Family practice","es":"Consultorio de medicina familiar"},"description":{"en":"A personal line for each doctor, plus an optional \"Anyone available\" line. Ticket numbers only on screens; no visit details in messages.","es":"Una fila propia para cada médico y una fila opcional \"Cualquiera disponible\". Solo números en las pantallas; ningún detalle de la visita en los mensajes."},"keywords":{"en":["family doctor","family practice","medical office","GP","physician","clinic"],"es":["médico de familia","medicina familiar","consultorio","médico general","clínica"]},"queues":[{"name":{"en":"Appointments","es":"Citas"},"prefix":"F","show_eta":true,"services":[{"name":{"en":"Visit","es":"Consulta"},"minutes":15},{"name":{"en":"New patient visit","es":"Consulta de paciente nuevo"},"minutes":30},{"name":{"en":"Annual check-up","es":"Revisión anual"},"minutes":30},{"name":{"en":"Forms and notes","es":"Formularios y justificantes"},"minutes":10}]}],"resources":[{"label":{"en":"Exam room 1","es":"Consultorio 1"},"kind":"room"},{"label":{"en":"Exam room 2","es":"Consultorio 2"},"kind":"room"},{"label":{"en":"Exam room 3","es":"Consultorio 3"},"kind":"room"}],"providers":{"noun":{"en":"doctor","es":"médico"},"default_count":3,"pool":true},"form":{"name":{"en":"Before your visit","es":"Antes de tu consulta"},"fields":[{"key":"new_patient","type":"yes_no","label":{"en":"Is this your first visit here?","es":"¿Es tu primera visita aquí?"},"help":{"en":"New patients may be asked to fill in a registration form at the front desk.","es":"Es posible que en recepción pidamos a los pacientes nuevos que llenen un formulario de registro."},"sensitivity":"normal"},{"key":"reason","type":"short_text","label":{"en":"Reason for the visit, in a few words","es":"Motivo de la visita, en pocas palabras"},"help":{"en":"For example \"sore throat\". Please don't include medical history; the doctor will ask.","es":"Por ejemplo \"dolor de garganta\". No incluyas tu historial médico; el médico te preguntará."},"sensitivity":"sensitive"}]},"booking":{"slot_minutes":15,"buffer_after_minutes":0,"min_notice_minutes":120,"max_days_ahead":60}}$catalog$::jsonb, 1, 'both', true),
  ('dental', 1, $catalog${"key":"dental","version":1,"tier":1,"mode":"both","health_tagged":true,"name":{"en":"Dental office","es":"Consultorio dental"},"description":{"en":"Check-ups, cleanings and urgent visits, mostly booked, with a line per dentist. Ticket numbers only on screens; no visit details in messages.","es":"Revisiones, limpiezas y urgencias, sobre todo con cita, con una fila por dentista. Solo números en las pantallas; ningún detalle de la visita en los mensajes."},"keywords":{"en":["dentist","dental","dental office","teeth cleaning","hygienist","orthodontist"],"es":["dentista","dental","consultorio dental","limpieza dental","higienista","odontólogo"]},"queues":[{"name":{"en":"Appointments","es":"Citas"},"prefix":"D","show_eta":true,"services":[{"name":{"en":"Check-up and cleaning","es":"Revisión y limpieza"},"minutes":60},{"name":{"en":"New patient exam","es":"Revisión de paciente nuevo"},"minutes":60},{"name":{"en":"Urgent visit","es":"Visita urgente"},"minutes":30},{"name":{"en":"Treatment visit","es":"Tratamiento"},"minutes":60},{"name":{"en":"Follow-up","es":"Seguimiento"},"minutes":20}]}],"resources":[{"label":{"en":"Dental chair 1","es":"Sillón dental 1"},"kind":"chair"},{"label":{"en":"Dental chair 2","es":"Sillón dental 2"},"kind":"chair"},{"label":{"en":"Dental chair 3","es":"Sillón dental 3"},"kind":"chair"}],"providers":{"noun":{"en":"dentist","es":"dentista"},"default_count":2,"pool":true},"form":{"name":{"en":"Before your visit","es":"Antes de tu visita"},"fields":[{"key":"new_patient","type":"yes_no","label":{"en":"Is this your first visit here?","es":"¿Es tu primera visita aquí?"},"help":{"en":"New patients may be asked to fill in a registration form at the front desk.","es":"Es posible que en recepción pidamos a los pacientes nuevos que llenen un formulario de registro."},"sensitivity":"normal"},{"key":"reason","type":"short_text","label":{"en":"Reason for the visit, in a few words","es":"Motivo de la visita, en pocas palabras"},"help":{"en":"For example \"cleaning\". Please don't include medical history; the dentist will ask.","es":"Por ejemplo \"limpieza\". No incluyas tu historial médico; el dentista te preguntará."},"sensitivity":"sensitive"}]},"booking":{"slot_minutes":15,"buffer_after_minutes":10,"min_notice_minutes":240,"max_days_ahead":90}}$catalog$::jsonb, 1, 'both', true),
  ('physio_chiro', 1, $catalog${"key":"physio_chiro","version":1,"tier":1,"mode":"both","health_tagged":true,"name":{"en":"Physio, chiro and massage therapy","es":"Fisioterapia, quiropráctica y masoterapia"},"description":{"en":"Assessments and treatments, mostly booked, with a line per practitioner and an optional \"Anyone available\" line. Ticket numbers only on screens.","es":"Evaluaciones y tratamientos, sobre todo con cita, con una fila por profesional y una fila opcional \"Cualquiera disponible\". Solo números en las pantallas."},"keywords":{"en":["physiotherapy","physio","chiropractor","massage therapy","RMT","rehab"],"es":["fisioterapia","fisioterapeuta","quiropráctico","masoterapia","rehabilitación"]},"queues":[{"name":{"en":"Appointments","es":"Citas"},"prefix":"P","show_eta":true,"services":[{"name":{"en":"Initial assessment","es":"Evaluación inicial"},"minutes":45},{"name":{"en":"Physiotherapy treatment","es":"Sesión de fisioterapia"},"minutes":30},{"name":{"en":"Chiropractic adjustment","es":"Ajuste quiropráctico"},"minutes":15},{"name":{"en":"Massage therapy, 30 minutes","es":"Masoterapia, 30 minutos"},"minutes":30},{"name":{"en":"Massage therapy, 60 minutes","es":"Masoterapia, 60 minutos"},"minutes":60}]}],"resources":[{"label":{"en":"Treatment room 1","es":"Sala de tratamiento 1"},"kind":"room"},{"label":{"en":"Treatment room 2","es":"Sala de tratamiento 2"},"kind":"room"},{"label":{"en":"Treatment room 3","es":"Sala de tratamiento 3"},"kind":"room"}],"providers":{"noun":{"en":"practitioner","es":"profesional"},"default_count":3,"pool":true},"form":{"name":{"en":"Before your visit","es":"Antes de tu visita"},"fields":[{"key":"new_patient","type":"yes_no","label":{"en":"Is this your first visit here?","es":"¿Es tu primera visita aquí?"},"help":{"en":"New patients may be asked to fill in a registration form at the front desk.","es":"Es posible que en recepción pidamos a los pacientes nuevos que llenen un formulario de registro."},"sensitivity":"normal"},{"key":"area","type":"short_text","label":{"en":"Area to work on, in a few words","es":"Zona a tratar, en pocas palabras"},"help":{"en":"For example \"lower back\". Please don't include medical history; your practitioner will ask.","es":"Por ejemplo \"espalda baja\". No incluyas tu historial médico; tu profesional te preguntará."},"sensitivity":"sensitive"}]},"booking":{"slot_minutes":15,"buffer_after_minutes":10,"min_notice_minutes":120,"max_days_ahead":60}}$catalog$::jsonb, 1, 'both', true),
  ('pharmacy', 1, $catalog${"key":"pharmacy","version":1,"tier":1,"mode":"walk_in","health_tagged":true,"name":{"en":"Pharmacy counter","es":"Mostrador de farmacia"},"description":{"en":"Pick-ups, drop-offs and pharmacist questions in one line. Ticket numbers only on screens, and no medicine names anywhere.","es":"Recogidas, entregas de recetas y consultas al farmacéutico en una sola fila. Solo números en las pantallas y ningún nombre de medicamento."},"keywords":{"en":["pharmacy","drugstore","pharmacist","prescription pick-up","chemist"],"es":["farmacia","farmacéutico","recoger receta","droguería","botica"]},"queues":[{"name":{"en":"Pharmacy","es":"Farmacia"},"prefix":"R","show_eta":true,"services":[{"name":{"en":"Pick up","es":"Recoger"},"minutes":5},{"name":{"en":"Drop off a prescription","es":"Entregar una receta"},"minutes":10},{"name":{"en":"Talk to the pharmacist","es":"Hablar con el farmacéutico"},"minutes":10},{"name":{"en":"Vaccination","es":"Vacunación"},"minutes":15}]}],"resources":[{"label":{"en":"Pick-up counter","es":"Mostrador de recogida"},"kind":"counter"},{"label":{"en":"Consultation room","es":"Sala de consulta"},"kind":"room"}],"form":{"name":{"en":"Before you wait","es":"Antes de esperar"},"fields":[{"key":"for_someone_else","type":"yes_no","label":{"en":"Are you here for someone else?","es":"¿Vienes de parte de otra persona?"},"sensitivity":"normal"}]}}$catalog$::jsonb, 1, 'walk_in', true);

-- ==================================================================== from 20261112090207_catalog_content_repair.sql

-- T8 (#1302, tracker #1267): catalog content. Each row is supabase/catalog/<key>.json verbatim (key, version, tier, mode and
-- health_tagged also become columns); the file is the source, linted by scripts/check-templates.ts.
-- Published versions are immutable, so a content change is a new file version and a new migration.
-- Files: auto_repair.json, device_repair.json.

insert into app.template_catalog (key, version, payload, tier, mode, health_tagged) values
  ('auto_repair', 1, $catalog${"key":"auto_repair","version":1,"tier":1,"mode":"both","health_tagged":false,"name":{"en":"Auto repair and tires","es":"Taller mecánico y llantas"},"description":{"en":"Oil changes, tire work and repairs, walk-in or booked, with a line per service bay.","es":"Cambios de aceite, llantas y reparaciones, con cita o sin cita, con una fila por bahía de servicio."},"keywords":{"en":["auto repair","mechanic","garage","tires","tyres","oil change","car service"],"es":["taller mecánico","mecánico","llantas","neumáticos","cambio de aceite","servicio de auto"]},"queues":[{"name":{"en":"Service desk","es":"Recepción de servicio"},"prefix":"A","show_eta":true,"services":[{"name":{"en":"Oil change","es":"Cambio de aceite"},"minutes":30},{"name":{"en":"Tire change or swap","es":"Cambio de llantas"},"minutes":45},{"name":{"en":"Flat tire repair","es":"Reparación de pinchazo"},"minutes":30},{"name":{"en":"Inspection or diagnosis","es":"Revisión o diagnóstico"},"minutes":60},{"name":{"en":"Brake check","es":"Revisión de frenos"},"minutes":45},{"name":{"en":"Battery check or replacement","es":"Revisión o cambio de batería"},"minutes":20}]}],"resources":[{"label":{"en":"Bay 1","es":"Bahía 1"},"kind":"counter"},{"label":{"en":"Bay 2","es":"Bahía 2"},"kind":"counter"},{"label":{"en":"Bay 3","es":"Bahía 3"},"kind":"counter"}],"form":{"name":{"en":"About your vehicle","es":"Sobre tu vehículo"},"fields":[{"key":"vehicle","type":"short_text","required":true,"label":{"en":"Vehicle make and model","es":"Marca y modelo del vehículo"},"help":{"en":"For example \"Toyota Corolla 2018\".","es":"Por ejemplo \"Toyota Corolla 2018\"."},"sensitivity":"normal"},{"key":"plate","type":"short_text","label":{"en":"Licence plate","es":"Placa"},"sensitivity":"personal"},{"key":"issue","type":"short_text","label":{"en":"What do you need?","es":"¿Qué necesitas?"},"help":{"en":"For example \"squeaky brakes\" or \"winter tires on\".","es":"Por ejemplo \"los frenos rechinan\" o \"poner llantas de invierno\"."},"sensitivity":"normal"}]},"booking":{"slot_minutes":30,"buffer_after_minutes":15,"min_notice_minutes":120,"max_days_ahead":30}}$catalog$::jsonb, 1, 'both', false),
  ('device_repair', 1, $catalog${"key":"device_repair","version":1,"tier":1,"mode":"both","health_tagged":false,"name":{"en":"Phone and computer repair","es":"Reparación de celulares y computadoras"},"description":{"en":"Screen, battery and repair drop-offs plus pick-ups, walk-in or booked, with two repair desks.","es":"Entregas para reparación de pantallas, baterías y más, y recogidas, con cita o sin cita, con dos mostradores."},"keywords":{"en":["phone repair","computer repair","screen repair","laptop","tablet","electronics"],"es":["reparación de celulares","reparación de computadoras","pantalla","laptop","tableta","electrónica"]},"queues":[{"name":{"en":"Repair desk","es":"Mostrador de reparación"},"prefix":"R","show_eta":true,"services":[{"name":{"en":"Screen repair","es":"Reparación de pantalla"},"minutes":45},{"name":{"en":"Battery replacement","es":"Cambio de batería"},"minutes":30},{"name":{"en":"Diagnosis","es":"Diagnóstico"},"minutes":15},{"name":{"en":"Drop off a repair","es":"Dejar un equipo para reparar"},"minutes":10},{"name":{"en":"Pick up a repair","es":"Recoger un equipo reparado"},"minutes":5}]}],"resources":[{"label":{"en":"Repair desk 1","es":"Mostrador 1"},"kind":"desk"},{"label":{"en":"Repair desk 2","es":"Mostrador 2"},"kind":"desk"}],"form":{"name":{"en":"About your device","es":"Sobre tu equipo"},"fields":[{"key":"device","type":"short_text","required":true,"label":{"en":"Device and model","es":"Equipo y modelo"},"help":{"en":"For example \"iPhone 13\" or \"Dell laptop\".","es":"Por ejemplo \"iPhone 13\" o \"laptop Dell\"."},"sensitivity":"normal"},{"key":"issue","type":"short_text","required":true,"label":{"en":"What's wrong with it?","es":"¿Qué le pasa?"},"help":{"en":"For example \"cracked screen\". Please don't share passcodes here.","es":"Por ejemplo \"pantalla rota\". No compartas contraseñas aquí."},"sensitivity":"normal"}]},"booking":{"slot_minutes":15,"buffer_after_minutes":5,"min_notice_minutes":60,"max_days_ahead":30}}$catalog$::jsonb, 1, 'both', false);

-- ==================================================================== from 20261112090852_guest_export_answers.sql

-- #1311: the per-guest data export (api.export_guest_data) includes the guest's intake answers, so a
-- right-of-access request (PIPEDA) is complete.
--
-- * Each visit and each appointment in the export gains an "answers" list: one entry per form response
--   with the form name, version, when it was given and last changed, and every answered field as
--   {key, label, type, visibility, value}. Staff-only fields are included: they are information held
--   about the guest, as staff notes already are. Agreement and signature answers carry their stored
--   evidence (text hash, accepted_at, typed name).
-- * A booking's response is listed once: under the visit once the booking has one (the carry points the
--   same row at the visit), otherwise under the appointment.
-- * A visit with legacy app.visit_answers and no form response (joined before F2, or a queue without a
--   form) lists those answers with labels from its queue's intake fields (form null).
-- * Access and audit are unchanged: owner or admin of the guest's org, aal2 when enrolled, one EXPORT
--   audit row per call (the row names the guest, never an answer).
--
-- Alternatives (interface rule 7):
--  1. Append an "answers" attribute to the api.guest_export record. Rejected: changes a fixed return type,
--     regenerates db-types for every caller, and answers would be detached from the visit they belong to.
--  2. A separate api.export_guest_answers(guest_id). Rejected: a second, shallower entry point that a
--     right-of-access screen could forget to call, with its own audit row to keep in step.
--  Chosen: nest answers in the existing visit and appointment entries (the tags/notes precedent in
--  20261030171052_guest_tags_notes.sql). Expand-only: older readers ignore the new key.

create function private.export_answer_entries(p_fields jsonb, p_answers jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', a.key,
           'label', coalesce(f.field ->> 'label', a.key),
           'type', f.field ->> 'type',
           'visibility', coalesce(f.field ->> 'visibility', 'guest'),
           'value', a.value) order by f.pos nulls last, a.key), '[]')
  from jsonb_each(coalesce(p_answers, '{}')) a
  left join lateral (
    select e as field, ord as pos from jsonb_array_elements(coalesce(p_fields, '[]')) with ordinality x(e, ord)
    where e ->> 'key' = a.key limit 1
  ) f on true
$$;
comment on function private.export_answer_entries(jsonb, jsonb) is
  'Answers as an ordered list of {key, label, type, visibility, value} using the given field list for labels '
  '(form order first, unknown keys last with the key as label). Pure; used only by the guest export.';
revoke all on function private.export_answer_entries(jsonb, jsonb) from public, anon, authenticated;

create function private.export_guest_answers(p_visit_id uuid, p_appointment_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(x.entry order by x.at), '[]')
  from (
    select r.created_at as at, jsonb_build_object(
             'form', f.name, 'form_version', fv.version,
             'given_at', r.created_at, 'updated_at', r.updated_at,
             'fields', private.export_answer_entries(fv.fields, r.answers)) as entry
    from app.form_responses r
    join app.form_versions fv on fv.id = r.form_version_id
    join app.forms f on f.id = fv.form_id
    where (p_visit_id is not null and r.visit_id = p_visit_id)
       or (p_appointment_id is not null and r.appointment_id = p_appointment_id and r.visit_id is null)
    union all
    select va.updated_at, jsonb_build_object(
             'form', null, 'form_version', null,
             'given_at', null, 'updated_at', va.updated_at,
             'fields', private.export_answer_entries(
               (select jsonb_agg(jsonb_build_object('key', i.key, 'label', i.label, 'type', i.type,
                                                    'visibility', i.visibility) order by i.position)
                from app.intake_fields i where i.queue_id = v.queue_id),
               va.answers))
    from app.visit_answers va
    join app.visits v on v.id = va.visit_id
    where p_visit_id is not null and va.visit_id = p_visit_id
      and not exists (select 1 from app.form_responses r where r.visit_id = p_visit_id)
  ) x
$$;
comment on function private.export_guest_answers(uuid, uuid) is
  'The intake answers held for one visit (pass the visit id) or one appointment (pass the appointment id; '
  'responses already carried to a visit are left to the visit). Each entry: form, form_version, given_at, '
  'updated_at, fields. Legacy visit_answers appear (form null) only when the visit has no form response. '
  'No access check: callers are definer functions that have already checked the caller.';
revoke all on function private.export_guest_answers(uuid, uuid) from public, anon, authenticated;

-- redefines api.export_guest_data from 20261030171052_guest_tags_notes.sql
create or replace function api.export_guest_data(p_guest_id uuid) returns api.guest_export
language plpgsql volatile security definer set search_path = '' as $$
declare
  g app.guests;
  r api.guest_export;
begin
  select * into g from app.guests where id = p_guest_id;
  if not found or not private.has_role(g.org_id, null, 'admin') then
    raise exception 'not_found';
  end if;
  perform private.require_aal2_if_enrolled();

  r.guest := to_jsonb(g) || jsonb_build_object(
    'tags', (select coalesce(jsonb_agg(t.name order by t.name), '[]')
             from app.guest_tag_links l join app.guest_tags t on t.id = l.tag_id where l.guest_id = g.id),
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('body', n.body, 'created_at', n.created_at)
                                        order by n.created_at), '[]')
              from app.guest_notes n where n.guest_id = g.id and n.deleted_at is null));
  select coalesce(jsonb_agg(to_jsonb(c) - 'org_id'), '[]') into r.contacts
  from app.guest_contacts c where c.guest_id = g.id;
  -- #1311: each visit carries its intake answers.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', v.id, 'ticket', v.display_ticket, 'status', v.status, 'name', v.guest_name,
           'phone', v.guest_phone_e164, 'email', v.guest_email, 'party_size', v.party_size,
           'source', v.source, 'joined_at', v.joined_at, 'called_at', v.called_at,
           'serving_at', v.serving_at, 'finished_at', v.finished_at,
           'answers', private.export_guest_answers(v.id, null)) order by v.joined_at), '[]')
    into r.visits from app.visits v where v.guest_id = g.id and v.org_id = g.org_id;
  select coalesce(jsonb_agg(to_jsonb(a) - 'guest_token_hash' - 'org_id'
                            || jsonb_build_object('answers', private.export_guest_answers(null, a.id))
                            order by a.starts_at), '[]')
    into r.appointments from app.appointments a where a.guest_id = g.id and a.org_id = g.org_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'visit_id', n.visit_id, 'channel', n.channel, 'template', n.template_key,
           'status', n.status, 'created_at', n.created_at) order by n.created_at), '[]')
    into r.notifications
  from app.notifications n
  where n.org_id = g.org_id and (n.visit_id in (select v.id from app.visits v where v.guest_id = g.id)
        or n.recipient_ref in (select c.id from app.guest_contacts c where c.guest_id = g.id));
  select coalesce(jsonb_agg(to_jsonb(k) - 'org_id' order by k.captured_at), '[]') into r.consents
  from app.consents k where k.contact_id in (select c.id from app.guest_contacts c where c.guest_id = g.id);
  r.generated_at := now();

  insert into app.audit_log (org_id, actor, role, action, table_name, row_id)
  values (g.org_id, (select auth.uid()), 'admin', 'EXPORT', 'guests', g.id::text);
  return r;
end $$;
comment on function api.export_guest_data(uuid) is
  'Everything held about one guest as jsonb sections: profile (with tags and notes), contacts, visits and '
  'appointments (each with its intake answers, staff-only fields included), notification log (no '
  'recipient), consents. Owner or admin of the guest''s org; audited as EXPORT (no answer values in the '
  'audit row). Raises not_found for a guest outside the caller''s orgs, mfa_required when the caller has '
  'an authenticator and the session is below aal2.';

notify pgrst, 'reload schema';
