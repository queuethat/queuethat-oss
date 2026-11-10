// 3-DOM1 (#370): the Supabase and DNS side of domain-check, built from whichever supabase-js the
// runtime has (index.ts passes Deno's npm import).
import {
  type DomainCheckDeps,
  type DomainToCheck,
  NotSignedInError,
  ResolverError,
} from './handler.ts';

// deno-lint-ignore no-explicit-any
type CreateClient = (url: string, key: string, options: any) => any;

const DOH = 'https://cloudflare-dns.com/dns-query';
const TXT = 16;

export function supabaseDeps(
  createClient: CreateClient,
  env: { url: string; serviceRoleKey: string; anonKey: string },
): Omit<DomainCheckDeps, 'secret' | 'log' | 'txt'> {
  const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(env.url, env.serviceRoleKey, noSession);
  const columns = 'id, hostname, verification_token';

  return {
    async resolve(host) {
      const { data, error } = await admin.schema('api').rpc('resolve_custom_domain', { p_host: host });
      if (error) throw new Error(error.message);
      return (data as string | null) ?? null;
    },
    async findForCaller(jwt, domainId) {
      // The caller's own JWT: the table's RLS policy (owner/admin) decides what they can see.
      const caller = createClient(env.url, env.anonKey, {
        ...noSession,
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { data, error } = await caller.schema('app').from('custom_domains').select(columns).eq('id', domainId).maybeSingle();
      if (error) {
        if (error.message === 'JWT expired' || error.code === 'PGRST301') throw new NotSignedInError();
        throw new Error(error.message);
      }
      return (data as DomainToCheck | null) ?? null;
    },
    async listVerified() {
      const { data, error } = await admin.schema('app').from('custom_domains').select(columns).eq('status', 'verified');
      if (error) throw new Error(error.message);
      return data as DomainToCheck[];
    },
    async record(domainId, ok) {
      const { data, error } = await admin.schema('api').rpc('record_domain_check', { p_domain_id: domainId, p_ok: ok });
      if (error) throw new Error(error.message);
      return (data as { status: string }).status;
    },
  };
}

/** TXT values over DNS-over-HTTPS. NXDOMAIN and "no TXT" are an empty list; a transport failure throws. */
export function dohTxt(fetchImpl: typeof fetch = fetch, endpoint = DOH): (name: string) => Promise<string[]> {
  return async (name) => {
    let res: Response;
    try {
      res = await fetchImpl(`${endpoint}?name=${encodeURIComponent(name)}&type=TXT`, {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      throw new ResolverError(String(e));
    }
    if (!res.ok) throw new ResolverError(`resolver answered ${res.status}`);
    const body = (await res.json().catch(() => null)) as { Status?: number; Answer?: { type: number; data: string }[] } | null;
    if (!body) throw new ResolverError('resolver answered with something that is not JSON');
    // Status 3 is NXDOMAIN: the name does not exist, which is an answer. Anything else but 0 is a resolver fault.
    if (body.Status !== 0 && body.Status !== 3) throw new ResolverError(`resolver status ${body.Status}`);
    return (body.Answer ?? [])
      .filter((a) => a.type === TXT)
      // A TXT value arrives as one or more quoted strings: "abc" "def" is abcdef.
      .map((a) => [...a.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('') || a.data);
  };
}
