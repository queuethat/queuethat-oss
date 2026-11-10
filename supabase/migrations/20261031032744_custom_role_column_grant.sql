-- 4-RBAC2 (#374): the team and roles pages show which custom role each member holds. Reading the
-- column is harmless (RLS still limits rows to the caller's own and, for admins, the org's);
-- writing stays ungranted: only api.set_member_custom_role (owner) changes it.
grant select (custom_role_id) on app.memberships to authenticated;
