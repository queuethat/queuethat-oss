-- 2B-Q12 (#237): per-queue accent and welcome text, one resolution order for them.
--   * Templates already resolve queue > org > system, per trigger, channel and locale
--     (private.resolve_template, 20261030062359_template_versions.sql), and
--     notification_templates_scope_idx already makes (org, queue, trigger, channel, locale) unique;
--     pgTAP template_resolution.test.sql pins both.
--   * queues gain brand_accent and welcome_text (<= 280 chars); null means "use the org / location".
--   * private.effective_queue_branding is the single place that decides which one wins. Guest
--     functions keep their fixed return types; exposing the effective values to guest pages is a
--     separate, security-reviewed change.

alter table app.queues
  add column brand_accent text check (brand_accent ~ '^#[0-9a-fA-F]{6}$'),
  add column welcome_text text check (char_length(welcome_text) <= 280);

create function private.effective_queue_branding(p_queue_id uuid)
returns table (brand_accent text, welcome_text text)
language sql stable set search_path = '' as $$
  select coalesce(q.brand_accent, o.brand_accent), coalesce(q.welcome_text, l.welcome_text)
  from app.queues q
  join app.organizations o on o.id = q.org_id
  join app.locations l on l.id = q.location_id
  where q.id = p_queue_id
$$;
comment on function private.effective_queue_branding(uuid) is
  'The accent colour and welcome text a queue shows: the queue''s own override, else the '
  'organization''s accent and the location''s welcome text. Empty for an unknown queue. Not exposed '
  'to clients.';
revoke all on function private.effective_queue_branding(uuid) from public, anon, authenticated;
grant execute on function private.effective_queue_branding(uuid) to service_role;
