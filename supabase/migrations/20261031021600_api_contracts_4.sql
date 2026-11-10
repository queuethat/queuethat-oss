-- 4-API1: the one phase 4 RPC whose signature a ticket binds (4-RPT1, #392), so the report builder,
-- its UI (#393) and the natural-language analytics ticket (#394) build against one type. Body raises
-- not_implemented; 4-RPT1 replaces it with `create or replace` and must not change the signature or
-- the return type. Other phase 4 tickets define their own RPCs (one owner per epic, plan wave5-epics.md).
-- private.has_permission (#373) is a private function and is created by its ticket, not stubbed here.

create type api.report_cell as (
  dims jsonb,
  measures jsonb
);
grant usage on type api.report_cell to authenticated, service_role;

create function api.run_report(p_definition jsonb, p_from date, p_to date) returns setof api.report_cell
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.run_report(jsonb, date, date) is
  'Runs a saved or ad-hoc report definition (whitelisted measures, dimensions and filters, never SQL) over the location days from p_from to p_to. Manager or above of the definition''s org; raises invalid_report_definition, range_too_large, not_found. Guest names and contacts are never a dimension. Stub until 4-RPT1 (#392) replaces the body; the signature is fixed.';

revoke execute on function api.run_report(jsonb, date, date) from public, anon, authenticated, service_role;
grant execute on function api.run_report(jsonb, date, date) to authenticated, service_role;

notify pgrst, 'reload schema';
