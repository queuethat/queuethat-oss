-- Extension hooks, part 2 (see 20261112085032_extension_hooks.sql and supabase/README.md): more
-- tenant functions where a deployment that runs a hosted service adds behaviour. Each hook
-- does nothing here; the tenant functions behave exactly as before.

create function private.ext_bills_shared_sms(p_org_id uuid) returns boolean
language sql stable set search_path = '' as $$ select false $$;
revoke execute on function private.ext_bills_shared_sms(uuid) from public;
comment on function private.ext_bills_shared_sms(uuid) is
  'Extension hook: true when the deployment bills p_org_id for SMS sent from its own shared sender '
  '(provider_settings.mode platform). Without it such SMS stays unavailable '
  '(private.channel_missing reports platform_requires_billing). Returns false here.';

create function private.ext_report_incident(p_org_id uuid, p_kind text, p_title text, p_description text,
  p_detected_at timestamptz, p_data_categories text[], p_idempotency_key uuid) returns uuid
language sql volatile set search_path = '' as $$ select null::uuid $$;
revoke execute on function private.ext_report_incident(uuid, text, text, text, timestamptz, text[], uuid) from public;
comment on function private.ext_report_incident(uuid, text, text, text, timestamptz, text[], uuid) is
  'Extension hook: takes an incident report that should reach the deployment''s operators '
  '(api.report_incident with p_notify_platform). Called after the caller''s role and the detection '
  'time are checked and before api.report_incident''s own idempotency, with a trimmed title and '
  'distinct categories. Returns the org_incident_log id it wrote, handling its own idempotency and '
  'validation (an idempotency key is scoped by org and caller, as private.claim_idempotent does), '
  'or null to let api.report_incident record a plain log entry. Returns null here.';

create function private.ext_support_context(p_org_id uuid) returns jsonb
language sql stable set search_path = '' as $$ select '{}'::jsonb $$;
revoke execute on function private.ext_support_context(uuid) from public;
comment on function private.ext_support_context(uuid) is
  'Extension hook: extra facts about p_org_id for whoever answers a support request (a JSON object, '
  'for example its plan). api.contact_support stores them in the request context and passes them to '
  'the support_request email. Keys that name a built-in field are dropped, and anything other than '
  'an object is ignored. No guest data. Returns {} here.';

create function private.ext_purge_keep_tables() returns text[]
language sql stable set search_path = '' as $$ select '{}'::text[] $$;
revoke execute on function private.ext_purge_keep_tables() from public;
comment on function private.ext_purge_keep_tables() is
  'Extension hook: names of app tables with an org_id that ops.purge_deleted_orgs must leave alone, '
  'because the deployment keeps rows there after the org is gone (counts keyed by org id, no '
  'foreign key). A listed table with a foreign key to the org still blocks the org''s deletion, so '
  'the purge fails closed and retries. Null entries are ignored. Returns an empty list here.';

create function private.ext_price_changed(p_org_id uuid, p_notification_id uuid, p_old_micros bigint,
  p_new_micros bigint) returns void
language plpgsql volatile set search_path = '' as $$ begin null; end $$;
revoke execute on function private.ext_price_changed(uuid, uuid, bigint, bigint) from public;
comment on function private.ext_price_changed(uuid, uuid, bigint, bigint) is
  'Extension hook: called by api.apply_provider_price, in its transaction, when a provider''s quoted '
  'price changes a sent message''s cost from p_old_micros to p_new_micros (either may be null). '
  'The deployment may settle the difference, for example against prepaid credit. Does nothing here.';

-- redefines private.channel_missing from 20261110171733_drop_hosted_schema.sql
create or replace function private.channel_missing(p_org_id uuid, p_channel text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  f app.platform_flags;
  s app.provider_settings;
  l app.channel_limits;
  missing text[] := '{}';
begin
  select * into f from app.platform_flags;
  select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel;
  if p_channel = 'sms' and not private.privacy_contact_recorded(p_org_id) then
    missing := array_append(missing, 'privacy_contact');
  end if;
  if p_channel in ('sms', 'whatsapp') and not private.entitled(p_org_id, 'paid_channels') then
    missing := array_append(missing, 'plan_allows_paid_channels');
  end if;
  -- the SMS compliance gate and the provider test event do not apply to an LLM key
  if p_channel not in ('llm', 'pos', 'crm') and f.compliance_gate_passed_at is null then missing := array_append(missing, 'compliance_gate'); end if;
  if not found then
    return array_append(missing, 'provider_settings');
  end if;
  if s.mode = 'platform' and f.hosted_legal_reviewed_at is null then missing := array_append(missing, 'hosted_legal_review'); end if;
  -- The deployment's kill switch holds for orgs already enabled (get_channel_config re-checks on every dispatch).
  if s.mode = 'platform' and not (select d.platform_messaging_enabled from private.deployment_settings d) then
    missing := array_append(missing, 'platform_messaging');
  end if;
  -- Platform-paid SMS is only for orgs the deployment bills for it (private.ext_bills_shared_sms).
  if s.mode = 'platform' and p_channel = 'sms' and not coalesce(private.ext_bills_shared_sms(p_org_id), false) then
    missing := array_append(missing, 'platform_requires_billing');
  end if;
  if s.verified_at is null and p_channel <> 'llm' then missing := array_append(missing, 'provider_verified'); end if;
  if p_channel = 'sms' then
    select * into l from app.channel_limits where org_id = p_org_id and channel = 'sms';
    -- no row means the defaults: a cap of 200 and no allowed country
    if coalesce(l.daily_cap, 200) <= 0 then missing := array_append(missing, 'daily_cap'); end if;
    if coalesce(cardinality(l.country_allowlist), 0) = 0 then missing := array_append(missing, 'country_allowlist'); end if;
    -- A US campaign is needed unless the sender is known to be outside +1 and no allowed country shares +1
    -- (the allowlist is matched against the number's calling code, so CA admits US numbers too).
    if (exists (select 1 from app.dial_codes d where d.prefix = '1' and d.country_code = any (coalesce(l.country_allowlist, '{}')))
        or regexp_replace(coalesce(s.config ->> 'from_number', ''), '\s', '', 'g') !~ '^\+'
        or regexp_replace(coalesce(s.config ->> 'from_number', ''), '\s', '', 'g') like '+1%')
       and coalesce(s.messaging_campaign_ref, '') = '' then
      missing := array_append(missing, 'campaign_ref');
    end if;
  end if;
  return missing;
end $function$;

-- redefines api.report_incident from 20261110171733_drop_hosted_schema.sql
create or replace function api.report_incident(p_org_id uuid, p_kind text, p_title text, p_description text DEFAULT NULL::text, p_detected_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_data_categories text[] DEFAULT '{}'::text[], p_notify_platform boolean DEFAULT true, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_title text := btrim(coalesce(p_title, ''));
  v_at timestamptz := coalesce(p_detected_at, now());
  v_cats text[] := coalesce((select array_agg(distinct c) from unnest(p_data_categories) c), '{}');
  v_replay boolean;
  v_saved jsonb;
  v_id uuid;
begin
  if not private.has_role(p_org_id, null, 'admin') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'invalid_input';
  end if;
  -- A deployment with an operator who should hear about it takes the report, with its own
  -- idempotency (private.ext_report_incident). Otherwise, and always here, it is an entry in the
  -- business's own log.
  if p_notify_platform then
    v_id := private.ext_report_incident(p_org_id, p_kind, v_title, p_description, v_at, v_cats, p_idempotency_key);
    if v_id is not null then
      return v_id;
    end if;
  end if;
  if p_idempotency_key is not null then
    select c.replay, c.response into v_replay, v_saved
    from private.claim_idempotent(p_org_id, 'report_incident', p_idempotency_key) c;
    if v_replay then
      return (v_saved ->> 'id')::uuid;
    end if;
  end if;
  begin
    insert into app.org_incident_log (org_id, source, kind, title, description, data_categories,
                                      detected_at, created_by)
    values (p_org_id, 'manual', p_kind, v_title, nullif(btrim(p_description), ''), v_cats, v_at, v_uid)
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception 'invalid_input';
  end;
  if p_idempotency_key is not null then
    perform private.save_idempotent('report_incident', p_idempotency_key, jsonb_build_object('id', v_id));
  end if;
  return v_id;
end $function$;

-- redefines api.contact_support from 20261110171733_drop_hosted_schema.sql
create or replace function api.contact_support(p_org_id uuid, p_subject text, p_message text, p_context jsonb DEFAULT NULL::jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  uid uuid := (select auth.uid());
  v_role app.member_role;
  v_subject text := btrim(coalesce(p_subject, ''), E' \t\r\n');
  v_message text := btrim(coalesce(p_message, ''), E' \t\r\n');
  v_in jsonb := coalesce(p_context, '{}');
  v_context jsonb;
  v_viewport jsonb;
  v_w int;
  v_h int;
  v_browser text;
  v_version text;
  v_error text;
  v_org text;
  v_email text;
  v_ext jsonb;
  r app.support_requests;
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- Only a member of the org, whatever its status. A stranger and a missing org look the same.
  select m.role into v_role from app.memberships m where m.org_id = p_org_id and m.user_id = uid;
  if not found then
    raise exception 'not_found';
  end if;

  if length(v_subject) not between 1 and 120 or v_subject ~ '[[:cntrl:]]'
     or length(v_message) not between 1 and 4000
     or regexp_replace(v_message, '[' || E'\n\r\t' || ']', '', 'g') ~ '[[:cntrl:]]'
     or jsonb_typeof(v_in) <> 'object' or length(v_in::text) > 4000 then
    raise exception 'invalid_input';
  end if;

  -- One person at a time, so the duplicate check and the rate limit cannot race.
  perform pg_advisory_xact_lock(hashtextextended('support_request:' || uid, 0));

  -- The same words again within a minute is a double click: same reference, nothing new sent.
  select * into r from app.support_requests x
  where x.user_id = uid and x.org_id = p_org_id and x.subject = v_subject and x.message = v_message
    and x.created_at > now() - interval '60 seconds'
  order by x.created_at desc limit 1;
  if found then
    return 'SR-' || lpad(r.number::text, 6, '0');
  end if;

  if (select count(*) from app.support_requests x
      where x.user_id = uid and x.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'rate_limited';
  end if;

  -- Whitelist: nothing else in p_context is kept (no storage, tokens, query strings or guest data).
  v_viewport := v_in -> 'viewport';
  if jsonb_typeof(v_viewport) = 'object'
     and jsonb_typeof(v_viewport -> 'w') = 'number' and jsonb_typeof(v_viewport -> 'h') = 'number' then
    v_w := least(greatest(round((v_viewport ->> 'w')::numeric), 0), 20000);
    v_h := least(greatest(round((v_viewport ->> 'h')::numeric), 0), 20000);
  end if;
  v_browser := case when jsonb_typeof(v_in -> 'browser') = 'string'
                    and (v_in ->> 'browser') !~ '[[:cntrl:]]' then left(v_in ->> 'browser', 200) end;
  v_version := case when jsonb_typeof(v_in -> 'app_version') = 'string'
                    and (v_in ->> 'app_version') ~ '^[A-Za-z0-9._-]{1,40}$' then v_in ->> 'app_version' end;
  v_error := case when jsonb_typeof(v_in -> 'last_error_id') = 'string'
                  and (v_in ->> 'last_error_id') ~ '^[A-Za-z0-9_-]{1,64}$' then v_in ->> 'last_error_id' end;

  select o.name into v_org from app.organizations o where o.id = p_org_id;
  -- Facts the deployment adds for whoever answers, such as the org's plan (private.ext_support_context).
  -- Only a JSON object counts, and it never sets a built-in field, even one that is null here.
  v_ext := private.ext_support_context(p_org_id);
  if jsonb_typeof(v_ext) is distinct from 'object' then
    v_ext := '{}';
  end if;
  v_ext := v_ext - array['route', 'app_version', 'browser', 'viewport', 'online', 'last_error_id',
                         'org_name', 'role', 'reference', 'org', 'org_id', 'user_email', 'subject',
                         'message'];
  v_context := v_ext || jsonb_strip_nulls(jsonb_build_object(
    'route', case when jsonb_typeof(v_in -> 'route') = 'string' then private.support_route(v_in ->> 'route') end,
    'app_version', v_version,
    'browser', v_browser,
    'viewport', case when v_w > 0 and v_h > 0 then jsonb_build_object('w', v_w, 'h', v_h) end,
    'online', case when jsonb_typeof(v_in -> 'online') = 'boolean' then v_in -> 'online' end,
    'last_error_id', v_error,
    'org_name', v_org,
    'role', v_role));

  insert into app.support_requests (org_id, user_id, subject, message, context)
  values (p_org_id, uid, v_subject, v_message, v_context)
  returning * into r;

  select u.email into v_email from auth.users u where u.id = uid;

  -- To the support inbox (private.notification_address resolves the recipient from the request), I-11.
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version,
                                 category, vars, dedupe_key)
  select p_org_id, null, 'email', r.id, 'support_request', t.version, t.category,
         v_ext || jsonb_strip_nulls(jsonb_build_object(
           'reference', 'SR-' || lpad(r.number::text, 6, '0'),
           'org', v_org, 'org_id', p_org_id, 'role', v_role,
           'user_email', v_email, 'subject', v_subject, 'message', v_message,
           'route', v_context ->> 'route', 'app_version', v_version, 'browser', v_browser,
           'viewport', case when v_w > 0 and v_h > 0 then v_w || 'x' || v_h end,
           'online', v_context ->> 'online', 'last_error_id', v_error)),
         'support_request:' || r.id
  from app.organizations o
  cross join lateral private.resolve_template(p_org_id, null, 'support_request', 'email', o.default_locale) t
  where o.id = p_org_id;

  -- To the requester, with the reference and no copy of the message.
  perform private.enqueue_user_email(
    p_org_id, uid, 'support_confirmation',
    jsonb_build_object('reference', 'SR-' || lpad(r.number::text, 6, '0'), 'subject', v_subject, 'org', v_org),
    'support_confirmation:' || r.id);

  return 'SR-' || lpad(r.number::text, 6, '0');
end $function$;

-- redefines ops.purge_deleted_orgs from 20261110171733_drop_hosted_schema.sql
create or replace function ops.purge_deleted_orgs()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_due uuid[];
  v_org uuid;
  v_requested timestamptz;
  v_tables text[];
  v_pending text[];
  v_next text[];
  t text;
  n int := 0;
begin
  select array_agg(c.table_name order by c.table_name) into v_tables
  from information_schema.columns c
  join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
  where c.table_schema = 'app' and c.column_name = 'org_id' and x.table_type = 'BASE TABLE'
    -- Tables the deployment keeps after an org is gone, such as counts keyed by org id.
    and c.table_name <> all (array_remove(coalesce(private.ext_purge_keep_tables(), '{}'), null));

  -- Read up front: the loop below alters tables, which fails while a cursor on them is open.
  -- Orgs whose storage files and device users are not gone yet are handed to purge-org first;
  -- the function reports back through api.mark_org_purged_externally and the next run purges.
  perform private.kick_purge_org(o.id) from app.organizations o
  where o.status = 'pending_deletion' and o.deletion_scheduled_for <= now() and o.external_purged_at is null;
  select coalesce(array_agg(id), '{}') into v_due from app.organizations
  where status = 'pending_deletion' and deletion_scheduled_for <= now() and external_purged_at is not null;
  foreach v_org in array v_due loop
    select deletion_requested_at into v_requested from app.organizations where id = v_org;
    begin -- one org's failure rolls back only that org and leaves the others to purge
    foreach t in array v_tables || 'organizations'::text loop
      execute format('alter table app.%I disable trigger user', t);
    end loop;
    -- Foreign keys stay enforced: a table that still has children is retried after them.
    v_pending := v_tables;
    for i in 1..20 loop
      v_next := '{}';
      foreach t in array v_pending loop
        begin
          execute format('delete from app.%I where org_id = $1', t) using v_org;
        exception when foreign_key_violation then
          v_next := v_next || t;
        end;
      end loop;
      v_pending := v_next;
      exit when cardinality(v_pending) = 0;
    end loop;
    if cardinality(v_pending) > 0 then
      raise exception 'purge_incomplete' using detail = array_to_string(v_pending, ',');
    end if;
    delete from app.organizations where id = v_org;
    foreach t in array v_tables || 'organizations'::text loop
      execute format('alter table app.%I enable trigger user', t);
    end loop;
    insert into ops.org_deletion_log (org_id, requested_at) values (v_org, v_requested);
    n := n + 1;
    exception when others then
      raise warning 'purge_deleted_orgs: org % failed: %', v_org, sqlerrm;
    end;
  end loop;
  return n;
end $function$;

-- redefines api.apply_provider_price from 20261110171733_drop_hosted_schema.sql
create or replace function api.apply_provider_price(p_org_id uuid, p_notification_id uuid, p_price numeric, p_currency text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_old bigint;
  v_new bigint;
begin
  select n.cost_micros into v_old from app.notifications n
  where n.id = p_notification_id and n.org_id = p_org_id and n.cost_source = 'estimate' for update;
  if not found then return; end if;
  update app.notifications n set
    price_checked_at = now(),
    cost_micros = case when p_price is null then n.cost_micros else round(abs(p_price) * 1000000)::bigint end,
    currency = case when p_price is null then n.currency else upper(left(coalesce(p_currency, n.currency), 3)) end,
    cost_source = case when p_price is null then n.cost_source else 'provider' end
  where n.id = p_notification_id and n.org_id = p_org_id
  returning n.cost_micros into v_new;
  -- The deployment may settle the difference, for example against prepaid credit.
  if v_new is distinct from v_old then
    perform private.ext_price_changed(p_org_id, p_notification_id, v_old, v_new);
  end if;
end $function$;
