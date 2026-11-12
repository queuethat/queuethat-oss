-- F7b (#1396, tracker #1267): contract step of F7 (#1283). Staff read a visit's form answers only through
-- api.get_visit_answers, which writes the audit_log READ row. The expand step (I-12) left the direct SELECT
-- policies in place for console bundles that still read the tables; a staff member calling the REST API
-- could therefore read answers without an access row. This closes that path.
--
-- * Replaces visit_answers_select and form_responses_select with admit-nothing policies and revokes SELECT on both tables from
--   authenticated (anon never had any). With no policy and no grant a direct read is permission denied for
--   every member role; the definer functions that own the tables (join_core, set_visit_answers,
--   set_booking_answers, get_visit_answers, the waiver and guest-answer exports) are unaffected.
--
-- Alternatives (rule 7): keep the SELECT policies and rely on the console (a REST read skips the audit row)
-- vs revoke so the audited function is the only reader (chosen). Only reader outside the database was the
-- old console bundle: `grep visit_answers\|form_responses apps supabase/functions` finds only the RPCs.

drop policy visit_answers_select on app.visit_answers;
drop policy form_responses_select on app.form_responses;
revoke select on app.visit_answers, app.form_responses from authenticated;
-- A table with RLS on needs a policy (tests.tables_without_policies); this one admits no row, like pay_codes_none.
create policy visit_answers_none on app.visit_answers for select to authenticated using (false);
create policy form_responses_none on app.form_responses for select to authenticated using (false);
