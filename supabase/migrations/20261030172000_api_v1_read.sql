-- 2B-I3 (#308): the versioned public REST API, read side. A new schema api_v1 is exposed by
-- PostgREST (Accept-Profile: api_v1). Every function authenticates the X-API-Key header through
-- private.require_api_scope, never a user JWT, and returns a stable shape that is not the table.
-- Guest contact data and names are never returned.

create schema api_v1;
grant usage on schema api_v1 to anon, authenticated, service_role;

create type api_v1.queue as (
  id uuid,
  location_id uuid,
  name text,
  state text,            -- open | paused | closed | not_accepting reason, as the guest page sees it
  accepting boolean,
  waiting_count int,
  eta_state text,
  eta_low_minutes int,
  eta_high_minutes int
);

create type api_v1.visit as (
  id uuid,
  queue_id uuid,
  ticket text,
  status text,
  party_size int,
  joined_at timestamptz,
  called_at timestamptz,
  serving_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz
);

-- Authenticates X-API-Key, checks the scope and charges one request to the key's minute budget.
create function private.require_api_scope(p_scope text)
returns table (org_id uuid, key_id uuid, location_ids uuid[])
language plpgsql volatile security definer set search_path = '' as $$
declare
  headers jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}');
  a record;
  w timestamptz := date_trunc('minute', now());
  n int;
begin
  select * into a from private.authenticate_api_key(btrim(coalesce(headers ->> 'x-api-key', '')));
  if not (p_scope = any (a.scopes)) then raise exception 'insufficient_scope'; end if;
  insert into private.rate_buckets as b (key, window_start, count)
  values ('apikey:' || a.key_id, w, 1)
  on conflict (key, window_start) do update set count = b.count + 1
  returning b.count into n;
  if n > 600 then raise exception 'rate_limited'; end if;
  return query select a.org_id, a.key_id, a.location_ids;
end $$;
comment on function private.require_api_scope(text) is
  'Authenticates the X-API-Key request header and requires p_scope. Raises unauthorized, '
  'insufficient_scope, or rate_limited (more than 600 requests per key per minute).';
revoke all on function private.require_api_scope(text) from public, anon, authenticated;
-- Known limit: PostgREST runs a call in one transaction, so a request that later raises (not_found,
-- invalid_input) rolls its rate-limit charge back; only successful requests count. Errors are cheap
-- (one hash and one lookup), and the edge proxy is the guard against floods.

create function private.v1_queue(p_queue_id uuid) returns api_v1.queue
language sql stable security definer set search_path = '' as $$
  select q.id, q.location_id, q.name,
         coalesce(private.queue_not_accepting_reason(q.id), q.manual_state::text),
         private.queue_not_accepting_reason(q.id) is null and q.manual_state = 'open',
         (select count(*)::int from app.visits v where v.queue_id = q.id and v.status = 'waiting'),
         e.eta_state::text, e.eta_low, e.eta_high
  from app.queues q, lateral private.queue_eta(q.id) e
  where q.id = p_queue_id
$$;
revoke all on function private.v1_queue(uuid) from public, anon, authenticated;

create function api_v1.list_queues() returns setof api_v1.queue
language plpgsql volatile security definer set search_path = '' as $$
declare k record;
begin
  select * into k from private.require_api_scope('queues:read');
  return query
    select (private.v1_queue(q.id)).*
    from app.queues q
    where q.org_id = k.org_id and q.archived_at is null
      and (k.location_ids is null or q.location_id = any (k.location_ids))
    order by q.sort_order, q.name, q.id;
end $$;
comment on function api_v1.list_queues() is
  'API v1: the org''s live queues the key may see (all locations, or the key''s own). Scope queues:read.';

create function api_v1.get_queue(p_queue_id uuid) returns api_v1.queue
language plpgsql volatile security definer set search_path = '' as $$
declare k record; r api_v1.queue;
begin
  select * into k from private.require_api_scope('queues:read');
  select (private.v1_queue(q.id)).* into r
  from app.queues q
  where q.id = p_queue_id and q.org_id = k.org_id
    and (k.location_ids is null or q.location_id = any (k.location_ids));
  if r.id is null then raise exception 'not_found'; end if;
  return r;
end $$;
comment on function api_v1.get_queue(uuid) is
  'API v1: one queue with state, waiting count and ETA summary. Scope queues:read. not_found for an unknown or foreign queue.';

create function api_v1.list_visits(p_queue_id uuid, p_status text[] default null,
                                   p_updated_after timestamptz default null, p_limit int default 100)
returns setof api_v1.visit
language plpgsql volatile security definer set search_path = '' as $$
declare k record; st api.visit_state[];
begin
  select * into k from private.require_api_scope('visits:read');
  if not exists (select 1 from app.queues q where q.id = p_queue_id and q.org_id = k.org_id
                 and (k.location_ids is null or q.location_id = any (k.location_ids))) then
    raise exception 'not_found';
  end if;
  begin
    st := p_status::api.visit_state[];
  exception when invalid_text_representation then
    raise exception 'invalid_input';
  end;
  return query
    select v.id, v.queue_id, v.display_ticket, v.status::text, v.party_size, v.joined_at,
           v.called_at, v.serving_at, v.finished_at,
           greatest(v.joined_at, v.called_at, v.serving_at, v.finished_at)
    from app.visits v
    where v.queue_id = p_queue_id
      and (st is null or v.status = any (st))
      and (p_updated_after is null
           or greatest(v.joined_at, v.called_at, v.serving_at, v.finished_at) >= p_updated_after)
    order by greatest(v.joined_at, v.called_at, v.serving_at, v.finished_at), v.id
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;
comment on function api_v1.list_visits(uuid, text[], timestamptz, int) is
  'API v1: visits of one queue, oldest change first (updated_at = latest of the visit''s timestamps), '
  'at most 500 per call; page with p_updated_after (inclusive, so repeat rows by id: nothing is skipped). No guest names or contact data. Scope visits:read.';

create function api_v1.get_visit(p_visit_id uuid) returns api_v1.visit
language plpgsql volatile security definer set search_path = '' as $$
declare k record; r api_v1.visit;
begin
  select * into k from private.require_api_scope('visits:read');
  select v.id, v.queue_id, v.display_ticket, v.status::text, v.party_size, v.joined_at,
         v.called_at, v.serving_at, v.finished_at,
         greatest(v.joined_at, v.called_at, v.serving_at, v.finished_at)
  into r
  from app.visits v join app.queues q on q.id = v.queue_id
  where v.id = p_visit_id and v.org_id = k.org_id
    and (k.location_ids is null or q.location_id = any (k.location_ids));
  if r.id is null then raise exception 'not_found'; end if;
  return r;
end $$;
comment on function api_v1.get_visit(uuid) is
  'API v1: one visit. No guest names or contact data. Scope visits:read. not_found for an unknown or foreign visit.';

grant execute on function api_v1.list_queues(), api_v1.get_queue(uuid),
  api_v1.list_visits(uuid, text[], timestamptz, int), api_v1.get_visit(uuid)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
