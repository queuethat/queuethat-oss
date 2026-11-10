import { execFileSync } from 'node:child_process';

/** Connection details for the local Supabase stack that the e2e run talks to. */
export interface SupabaseEnv {
  url: string;
  anonKey: string;
  /** Node-side only (pair-device stand-in in device.spec.ts). Never sent to a browser. */
  serviceRoleKey: string;
}

/**
 * Reads the local stack's URL and anon key once per run. `E2E_SUPABASE_URL`,
 * `E2E_SUPABASE_ANON_KEY` and `E2E_SUPABASE_SERVICE_ROLE_KEY` win when set; otherwise they come from `supabase status` and are
 * cached in `process.env`, which workers inherit.
 */
export function supabaseEnv(): SupabaseEnv {
  if (process.env.E2E_PILOT === '1') return pilotEnv();
  if (
    !process.env.E2E_SUPABASE_URL ||
    !process.env.E2E_SUPABASE_ANON_KEY ||
    !process.env.E2E_SUPABASE_SERVICE_ROLE_KEY
  ) {
    const status = readStatus();
    process.env.E2E_SUPABASE_URL ??= status.API_URL;
    process.env.E2E_SUPABASE_ANON_KEY ??= status.ANON_KEY;
    process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ??= status.SERVICE_ROLE_KEY;
  }
  return {
    url: process.env.E2E_SUPABASE_URL!,
    anonKey: process.env.E2E_SUPABASE_ANON_KEY!,
    serviceRoleKey: process.env.E2E_SUPABASE_SERVICE_ROLE_KEY!,
  };
}

function readStatus(): Record<string, string> {
  let out: string;
  try {
    out = execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'env'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(
      'The local Supabase stack is not running. Start it with `pnpm db:start`, or set E2E_SUPABASE_URL and E2E_SUPABASE_ANON_KEY.',
    );
  }
  const vars: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match) vars[match[1]!] = match[2]!;
  }
  for (const key of ['API_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY']) {
    if (!vars[key]) throw new Error(`\`supabase status\` did not report ${key}.`);
  }
  return vars;
}

/**
 * Against a real project (`pnpm test:e2e:pilot`) only the public URL and anon key exist, so the
 * service role key is a getter that throws: any code path that needs it fails loudly instead of
 * silently working on the wrong database.
 */
function pilotEnv(): SupabaseEnv {
  const url = process.env.E2E_SUPABASE_URL;
  const anonKey = process.env.E2E_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Set E2E_SUPABASE_URL and E2E_SUPABASE_ANON_KEY (the pilot project, public values).',
    );
  }
  return {
    url,
    anonKey,
    get serviceRoleKey(): string {
      throw new Error('The service role key is not available against the pilot.');
    },
  };
}
