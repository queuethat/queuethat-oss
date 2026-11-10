-- 2B-G1 (#247): post-visit feedback. One 1-5 rating, optional 0-10 NPS and a comment per visit.
-- Expand-only. The comment is free text (personal data): a daily job nulls it after 90 days and
-- keeps the rating. Written only by api.guest_submit_feedback; staff of the location read.

alter table app.organizations
  add column feedback_enabled boolean not null default true,
  add column feedback_ask_nps boolean not null default false,
  add column feedback_include_no_show boolean not null default false;
grant update (feedback_enabled, feedback_ask_nps, feedback_include_no_show) on app.organizations to authenticated;

create table app.visit_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  visit_id uuid not null unique,
  rating smallint not null check (rating between 1 and 5),
  nps smallint check (nps between 0 and 10),
  comment varchar(1000),
  created_at timestamptz not null default now(),
  foreign key (org_id, visit_id) references app.visits (org_id, id),
  foreign key (org_id, location_id) references app.locations (org_id, id)
);
create index visit_feedback_loc_idx on app.visit_feedback (location_id, created_at desc);
comment on table app.visit_feedback is
  'Post-visit feedback, one row per visit. comment is personal data: nulled after 90 days by '
  'ops.feedback_retention_tick, the rating stays. Written only by api.guest_submit_feedback.';

create trigger forbid_org_change before update on app.visit_feedback
  for each row execute function private.forbid_org_change();

revoke insert, update, delete, truncate on app.visit_feedback from authenticated;
alter table app.visit_feedback enable row level security;
create policy visit_feedback_select on app.visit_feedback for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));

-- redefines api.guest_submit_feedback from 20261030162713_api_contracts_2b.sql
create or replace function api.guest_submit_feedback(p_token text, p_rating int, p_nps int, p_comment text, p_idempotency_key uuid)
returns api.feedback_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  o app.organizations;
  v_ended timestamptz;
  v_comment text := nullif(btrim(p_comment), '');
  v_id uuid;
begin
  -- Same POST-only rule as get_visit_status: the token must not reach a URL.
  if current_setting('request.method', true) = 'GET' then
    raise exception 'invalid_input' using detail = 'use POST';
  end if;
  if length(p_comment) > 4000 or p_rating is null or p_rating not between 1 and 5
     or (p_nps is not null and p_nps not between 0 and 10)
     or length(v_comment) > 1000 then
    raise exception 'invalid_input';
  end if;

  select * into v from app.visits where guest_token_hash = private.token_hash(coalesce(p_token, ''));
  if not found then
    raise exception 'not_found';
  end if;
  select * into o from app.organizations where id = v.org_id;
  v_ended := coalesce(v.finished_at,
                      (select max(e.occurred_at) from app.visit_events e where e.visit_id = v.id));
  if not o.feedback_enabled
     or not (v.status = 'served' or (v.status = 'no_show' and o.feedback_include_no_show))
     or v_ended < now() - interval '24 hours' then
    raise exception 'not_found';
  end if;

  insert into app.visit_feedback (org_id, location_id, visit_id, rating, nps, comment)
  values (v.org_id, v.location_id, v.id, p_rating, case when o.feedback_ask_nps then p_nps end, v_comment)
  on conflict (visit_id) do nothing
  returning id into v_id;
  return row(v_id is not null, v_id is null)::api.feedback_result;
end $$;
comment on function api.guest_submit_feedback(text, int, int, text, uuid) is
  'Stores one rating (1-5), optional NPS (0-10, kept only when the org asks for it) and comment '
  '(trimmed, max 1000) for the token''s served visit (also no_show when the org allows) within 24 '
  'hours of it ending. A second submission returns already_submitted and changes nothing. Raises '
  'not_found for an unknown token, a visit that has not ended or ended too long ago, or when '
  'feedback is off; invalid_input for out-of-range values or a GET request. p_idempotency_key is '
  'accepted for client symmetry: the unique visit_id already makes the call idempotent.';

create function ops.feedback_retention_tick() returns int
language sql volatile set search_path = '' as $$
  with d as (
    update app.visit_feedback set comment = null
    where comment is not null and created_at < now() - interval '90 days'
    returning 1)
  select count(*)::int from d
$$;
comment on function ops.feedback_retention_tick() is
  'Daily: nulls feedback comments older than 90 days (rating and NPS stay). Returns comments cleared. '
  'Not callable via the API.';
revoke all on function ops.feedback_retention_tick() from public, anon, authenticated;
select cron.schedule('feedback-retention', '37 2 * * *', 'select ops.feedback_retention_tick()');
