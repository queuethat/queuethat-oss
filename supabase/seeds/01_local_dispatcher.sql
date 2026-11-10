-- Local and CI only (seeds never reach the pilot). Points the database's dispatcher kick at the
-- local dispatch-notifications function, so queued notifications get sent on a fresh reset.
-- The key is a fixed local value: put the same DISPATCH_SECRET in supabase/functions/.env
-- (copy supabase/functions/.env.example) and `supabase start` hands it to the function.
-- Production sets both secrets by hand (docs/ops/pilot-deploy.md); never in a migration.
select vault.create_secret('http://kong:8000/functions/v1/dispatch-notifications', 'dispatcher_url',
                           'Local dispatcher (seed)');
select vault.create_secret('local-dispatch-secret-not-for-production', 'dispatcher_key',
                           'Local DISPATCH_SECRET (seed); matches supabase/functions/.env.example');
select vault.create_secret('http://kong:8000/functions/v1/reconcile-costs', 'reconcile_costs_url',
                           'Local reconcile-costs function (seed)');
