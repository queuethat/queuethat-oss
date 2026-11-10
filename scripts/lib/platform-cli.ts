// Shared by `pnpm platform:grant` and `pnpm platform:revoke` (service role, run on the maintainer's machine
// only). Failures throw CliError so the commands can be tested; the entry points print it and exit 1.
import { execFileSync } from 'node:child_process';

/** A failure the operator can act on; its message is printed as is. */
export class CliError extends Error {}

export interface Connection {
  url: string;
  key: string;
}

/** Calls the Supabase API with the service role; returns parsed JSON, or null for an empty body. */
export type Call = (path: string, init?: RequestInit) => Promise<unknown>;

/**
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for a hosted project, or neither for the local stack
 * (read from `supabase status`).
 */
export function connection(
  env: Record<string, string | undefined> = process.env,
  status: () => string = () =>
    execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'env'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
): Connection {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) return { url, key };
  if (url || key)
    throw new CliError(
      'Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or neither for local.',
    );
  let out: string;
  try {
    out = status();
  } catch {
    throw new CliError('Local Supabase is not running. Start it with `pnpm db:start`.');
  }
  const read = (name: string) => out.match(new RegExp(`^${name}="(.*)"$`, 'm'))?.[1];
  const localUrl = read('API_URL');
  const localKey = read('SERVICE_ROLE_KEY');
  if (!localUrl || !localKey)
    throw new CliError('Local Supabase is not running. Start it with `pnpm db:start`.');
  return { url: localUrl, key: localKey };
}

export function client({ url, key }: Connection, fetchImpl: typeof fetch = fetch): Call {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  return async (path, init = {}) => {
    const res = await fetchImpl(`${url}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    });
    const text = await res.text();
    if (!res.ok)
      throw new CliError(`${init.method ?? 'GET'} ${path} failed: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

/** The auth user with exactly this email (case-insensitive), or null. */
export async function findUser(call: Call, email: string): Promise<{ id: string } | null> {
  const { users } = (await call(
    `/auth/v1/admin/users?per_page=50&filter=${encodeURIComponent(email)}`,
  )) as { users: { id: string; email?: string }[] };
  return users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

/** Entry-point wrapper: prints a CliError and exits 1; anything else is a bug and propagates. */
export async function runCli(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
