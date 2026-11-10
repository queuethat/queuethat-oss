-- N3 (#69) security review: the dispatcher kick (20261025002000) leaves its Authorization header
-- in net.http_request_queue until pg_net sends it, and Supabase grants PUBLIC access to that table
-- (granted by supabase_admin, so this role cannot revoke it). The net schema is not exposed
-- through PostgREST, so no API caller can read it today. To bound the damage if that ever
-- changes, the vault secret `dispatcher_key` holds a dedicated DISPATCH_SECRET that can only start
-- a dispatcher run, never the service role key.

comment on function private.kick_dispatcher() is
  'Requests one dispatcher run after this transaction commits. Configure with vault secrets '
  'dispatcher_url and dispatcher_key (the function''s DISPATCH_SECRET, never the service role '
  'key, since queued requests are readable in net.http_request_queue). Never raises.';
