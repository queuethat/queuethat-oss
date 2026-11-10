-- An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is an IPv4 client: key it as that address, not as the
-- shared ::/64 network every mapped client fell into (proxy dual-stack sockets report this form).
-- Alternative rejected: handling it in the Edge Function only, which leaves direct callers of the database in one bucket.

-- redefines private.client_ip from 20261030064200_rate_buckets.sql
create or replace function private.client_ip() returns inet
language plpgsql stable set search_path = '' as $$
declare
  headers jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}');
  -- The public-join Edge Function reaches PostgREST through Kong, which overwrites x-real-ip with
  -- its own peer, so it forwards the guest's address in x-qm-client-ip. Only the service role
  -- (that function's key) is believed; anyone else's copy of the header is ignored.
  raw text := btrim(coalesce(
    case when (select auth.role()) = 'service_role' then headers ->> 'x-qm-client-ip' end,
    headers ->> (select s.client_ip_header from private.deployment_settings s)));
  ip inet;
begin
  if raw is null or raw = '' then
    return null;
  end if;
  begin
    ip := raw::inet;
  exception when invalid_text_representation then
    return null;
  end;
  if family(ip) = 6 then
    if ip << '::ffff:0:0/96'::inet then
      return host('0.0.0.0'::inet + (ip - '::ffff:0:0'::inet))::inet;
    end if;
    return network(set_masklen(ip, 64));
  end if;
  return host(ip)::inet;
end $$;

comment on function private.client_ip() is
  'Client IP from the header named in private.deployment_settings.client_ip_header (default '
  'x-real-ip), IPv6 as its /64 network, an IPv4-mapped IPv6 address as the IPv4 address. x-qm-client-ip replaces it for the service role (public-join). Null when absent or malformed.';
