-- 2B-J2 (#240): admins and owners switch the one-active-visit rule (J-16) from the console.
--
-- A column grant under the existing organizations_update policy (admin or above), as for
-- retention_days; app.organizations is audited, so the change is recorded.

grant update (single_active_visit) on app.organizations to authenticated;
