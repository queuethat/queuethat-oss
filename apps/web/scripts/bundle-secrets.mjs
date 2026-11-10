// Finds server-only Supabase secrets in built web assets (X-7, #74; technical-design.md
// section 5, "Secrets"). Everything in dist/ is public, so any hit is a leak.
//
// A legacy service-role key is a JWT, so the words "service_role" only appear once its
// payload is decoded; JWT-shaped strings are decoded and their `role` claim checked.

// Default JWT secret of `supabase start` and the self-host compose template.
export const DEMO_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

const JWT = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g;
// A whole key, not the bare prefix: supabase-js itself contains `startsWith("sb_secret_")`.
const SECRET_KEY = /sb_secret_[\w-]{16,}/;
// Sentry org and user auth tokens (the source-map upload token). The DSN is public by design.
const SENTRY_TOKEN = /sntry[su]_[\w+/=-]{20,}/;

function decodeJwtRole(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.role === 'string' ? payload.role : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns one finding per leaked secret in `text`. `extraSecrets` are literal values to
 * look for too, such as this environment's JWT secret or service-role key.
 */
export function findSecrets(text, extraSecrets = []) {
  const findings = [];
  if (text.includes('service_role')) findings.push('the string "service_role"');
  if (SECRET_KEY.test(text)) findings.push('a secret API key (sb_secret_…)');
  if (SENTRY_TOKEN.test(text)) findings.push('a Sentry auth token');
  if (text.includes(DEMO_JWT_SECRET)) findings.push('the Supabase demo JWT secret');
  for (const secret of extraSecrets) {
    if (secret && text.includes(secret)) findings.push('a secret from the build environment');
  }
  for (const [token] of text.matchAll(JWT)) {
    if (decodeJwtRole(token) === 'service_role') findings.push('a service_role JWT');
  }
  return findings;
}
