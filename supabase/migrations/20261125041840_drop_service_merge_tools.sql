-- The one-off duplicate-service merge tools (20261122085036_location_services_switch.sql) have done their job:
-- every hosted location was merged, and new locations never create copies. No legacy to maintain, so they go.
-- Keeps app.services.merged_into_id (retired copies stay readable) and the Services page notice.
drop function if exists private.merge_identical_services(uuid);
drop function if exists private.service_merge_plan(uuid);
