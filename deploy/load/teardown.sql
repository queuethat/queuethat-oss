set client_min_messages = warning;
-- Removes the K1 spike fixture installed by setup.sql.
drop function if exists api.loadtest_call_next(uuid);
drop function if exists api.loadtest_visit_status(text);
drop schema if exists loadtest cascade;
