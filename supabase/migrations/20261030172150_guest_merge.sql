-- redefines api.duplicate_guest_candidates from 20261030162713_api_contracts_2b.sql
-- redefines api.merge_guests from 20261030162713_api_contracts_2b.sql
-- 2B-C3 (#302): duplicate guest detection and merge (C-5).
--
-- app.guest_contacts is unique per (org, channel, value), so two guests never share an exact
-- phone or email. Duplicates therefore show up as near matches: a phone with the same last nine
-- digits (country code typed or not) or an email that differs only by a +tag or dots. Visits are
-- repointed, never deleted (I-1); the merged guest stays as a tombstone with merged_into_id.

alter table app.guests add column merged_into_id uuid;
alter table app.guests add foreign key (org_id, merged_into_id)
  references app.guests (org_id, id) on delete set null (merged_into_id);

create function private.guest_row_of(p_guest_id uuid) returns api.guest_row
language sql stable set search_path = '' as $$
  select g.id, g.first_name,
    coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'channel', c.channel, 'value', c.value,
                                                   'verified_at', c.verified_at) order by c.created_at)
              from app.guest_contacts c where c.guest_id = g.id), '[]'),
    coalesce((select array_agg(t.name order by t.name)
              from app.guest_tag_links l join app.guest_tags t on t.id = l.tag_id
              where l.guest_id = g.id), '{}'),
    (select count(*)::int from app.visits v where v.guest_id = g.id),
    (select max(v.joined_at) from app.visits v where v.guest_id = g.id)
  from app.guests g where g.id = p_guest_id
$$;
revoke all on function private.guest_row_of(uuid) from public, anon, authenticated;

create or replace function api.duplicate_guest_candidates(p_org_id uuid, p_limit int default 50) returns setof api.duplicate_pair
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_role(p_org_id, null, 'manager') then
    raise exception 'not_found';
  end if;
  return query
  with live as (
    select g.id, g.created_at, lower(btrim(g.first_name)) as nm
    from app.guests g
    where g.org_id = p_org_id and g.merged_into_id is null and g.anonymized_at is null
  ), keyed as (
    select c.guest_id, c.channel,
      case c.channel
        when 'phone' then right(c.value, 9)
        else replace(split_part(split_part(c.value, '@', 1), '+', 1), '.', '') || '@' || split_part(c.value, '@', 2)
      end as k,
      c.value
    from app.guest_contacts c join live l on l.id = c.guest_id
    where c.org_id = p_org_id
  ), pairs as (
    select distinct on (a.guest_id, b.guest_id) a.guest_id as a_id, b.guest_id as b_id,
      case a.channel when 'phone' then 'same_phone' else 'same_email' end as reason
    from keyed a join keyed b on a.channel = b.channel and a.k = b.k and a.guest_id < b.guest_id
    where a.value <> b.value
    order by a.guest_id, b.guest_id
  )
  select case when la.created_at <= lb.created_at then la.id else lb.id end,
         case when la.created_at <= lb.created_at then lb.id else la.id end,
         p.reason,
         (case when la.nm is not null and la.nm = lb.nm then 1.0 else 0.8 end)::numeric
  from pairs p join live la on la.id = p.a_id join live lb on lb.id = p.b_id
  order by 4 desc, 1, 2
  limit greatest(coalesce(p_limit, 50), 0);
end $$;
comment on function api.duplicate_guest_candidates(uuid, int) is
  'Likely duplicate guest pairs of the org, best first; keep_id is the older profile. Pairs share a '
  'phone with the same last nine digits or an email equal after dropping dots and a +tag in the '
  'local part; a matching first name raises the score from 0.8 to 1.0. Merged and anonymized '
  'guests are skipped. Manager or above, otherwise not_found. Implemented in 2B-C3 (#302).';

create or replace function api.merge_guests(p_keep_id uuid, p_merge_id uuid, p_idempotency_key uuid) returns api.guest_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  k app.guests;
  m app.guests;
  v_claim record;
begin
  if p_keep_id is null or p_merge_id is null or p_idempotency_key is null or p_keep_id = p_merge_id then
    raise exception 'invalid_input';
  end if;
  -- Authorize on unlocked reads first, so a caller who guesses ids cannot take locks.
  select * into k from app.guests where id = p_keep_id;
  select * into m from app.guests where id = p_merge_id;
  if k.id is null or m.id is null or k.org_id <> m.org_id
     or not private.has_role(k.org_id, null, 'admin') then
    raise exception 'not_found';
  end if;
  -- Lock in id order so two opposite merges cannot deadlock, then re-read the locked rows.
  perform 1 from app.guests where id in (p_keep_id, p_merge_id) order by id for update;
  select * into k from app.guests where id = p_keep_id;
  select * into m from app.guests where id = p_merge_id;
  perform private.require_aal2_if_enrolled();

  select * into v_claim from private.claim_idempotent(k.org_id, 'merge_guests', p_idempotency_key);
  if v_claim.replay or m.merged_into_id = k.id then
    return private.guest_row_of(k.id); -- already merged: a repeat is a no-op
  end if;
  if k.merged_into_id is not null or m.merged_into_id is not null
     or k.anonymized_at is not null or m.anonymized_at is not null then
    raise exception 'invalid_input';
  end if;

  -- Visits keep their history; each repointed visit writes an 'updated' event.
  perform private.set_actor('staff', (select auth.uid()), null, 'guest_merged');
  update app.visits set guest_id = k.id where org_id = k.org_id and guest_id = m.id;
  update app.appointments set guest_id = k.id where org_id = k.org_id and guest_id = m.id;
  -- Contacts carry their consents with them (consents reference the contact), so no consent
  -- evidence is lost. Values are unique per org, so nothing can collide.
  update app.guest_contacts set guest_id = k.id where org_id = k.org_id and guest_id = m.id;
  insert into app.guest_tag_links (org_id, guest_id, tag_id)
  select org_id, k.id, tag_id from app.guest_tag_links where guest_id = m.id
  on conflict do nothing;
  delete from app.guest_tag_links where guest_id = m.id;
  update app.guest_notes set guest_id = k.id where org_id = k.org_id and guest_id = m.id;

  update app.guests set merged_into_id = k.id, first_name = null where id = m.id;
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, before, after)
  values (k.org_id, (select auth.uid()), 'admin', 'UPDATE', 'guests', m.id::text,
          jsonb_build_object('guest_id', m.id, 'first_name', m.first_name),
          jsonb_build_object('merged_into_id', k.id));
  perform private.save_idempotent('merge_guests', p_idempotency_key, jsonb_build_object('id', k.id));
  return private.guest_row_of(k.id);
end $$;
comment on function api.merge_guests(uuid, uuid, uuid) is
  'Merges p_merge_id into p_keep_id: visits, appointments, contacts (with their consents), tags and '
  'notes move to the survivor; the other guest stays as a tombstone (merged_into_id, name cleared). '
  'Visits are never deleted (I-1). Admin or above; guests of different orgs, unknown guests and '
  'callers below admin get not_found, merging a guest into itself or a tombstone invalid_input, '
  'mfa_required below aal2 for enrolled callers. Repeating a merge is a no-op. Audited. '
  'Idempotent on p_idempotency_key. Implemented in 2B-C3 (#302).';
