-- W7 (#1361, tracker #1267): waiver evidence has its own retention, a tenant setting.
--
-- Riz decision 2026-11-09: waiver retention is configurable per tenant, default 365 days, up to 7 years
-- (2555). Every other form answer stays under the organisation's retention_days (capped at 365).
--
-- * app.organizations.waiver_retention_days (default 365, 1 to 2555). Admins and owners change it like
--   retention_days (RLS organizations_update; organizations are audited).
-- * W2 deleted an acceptance with its form response (ON DELETE CASCADE). That tied evidence to the answers'
--   schedule, so the FK is dropped and ops.waiver_retention_tick deletes evidence once it is older than the
--   organisation's waiver_retention_days. form_response_id stays as a plain column (with the unique key the
--   trigger relies on). Everything else about the table is unchanged; org deletion still removes the rows
--   (it deletes every org_id table).
-- * A separate daily tick instead of a new branch in ops.retention_tick: that body has been copied by many
--   PRs, and the waiver schedule differs from everything else it purges (interface rule 5, one owner).
-- Consequence to review: anonymising a visit no longer removes its waiver evidence (typed name, guardian)
-- before the waiver period ends. That is the point of a longer waiver period; it is on the decision list.

alter table app.organizations
  add column waiver_retention_days int not null default 365 check (waiver_retention_days between 1 and 2555);
comment on column app.organizations.waiver_retention_days is
  'Days waiver acceptance records (app.waiver_acceptances) are kept after acceptance. Default 365, at most 2555 '
  '(7 years). Independent of retention_days, which still governs answers and guest details.';
grant update (waiver_retention_days) on app.organizations to authenticated;

alter table app.waiver_acceptances drop constraint waiver_acceptances_form_response_id_fkey;
comment on column app.waiver_acceptances.form_response_id is
  'The response the agreement was accepted in. Not a foreign key: the record outlives the response and is '
  'deleted by ops.waiver_retention_tick on the organisation''s waiver_retention_days.';

create function ops.waiver_retention_tick() returns int
language sql volatile set search_path = '' as $$
  with d as (
    delete from app.waiver_acceptances w using app.organizations o
    where o.id = w.org_id and w.accepted_at < now() - make_interval(days => o.waiver_retention_days)
    returning 1)
  select count(*)::int from d
$$;
comment on function ops.waiver_retention_tick() is
  'Daily: deletes waiver acceptance records older than their organisation''s waiver_retention_days. '
  'Returns rows deleted. Not callable via the API.';
revoke all on function ops.waiver_retention_tick() from public, anon, authenticated;
select cron.schedule('waiver-retention', '47 2 * * *', 'select ops.waiver_retention_tick()');
