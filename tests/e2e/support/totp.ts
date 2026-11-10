import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { accessToken, confirmedAccount, signInTo } from './accounts.ts';
import { supabaseEnv } from './env.ts';

/** RFC 6238 code (SHA-1, 6 digits, 30 s) for a base32 `secret`, `stepOffset` steps from now. */
export function totp(secret: string, stepOffset = 0, now = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000) + stepOffset));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

/**
 * A fresh account with the platform `operator` role and no MFA factor. The role is written with
 * the service role, the way `pnpm platform:grant` does it.
 */
export async function newOperator(): Promise<string> {
  const email = await confirmedAccount();
  const token = await accessToken(email);
  const userId = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sub;
  const { url, serviceRoleKey } = supabaseEnv();
  const response = await fetch(`${url}/rest/v1/platform_roles`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-profile': 'app',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId, role: 'operator' }),
  });
  expect(response.status).toBe(201);
  return email;
}

/**
 * Calls an aal2-only platform RPC with the page's own session, so the answer says whether that
 * session really reached aal2: 200 if so, 403 (permission_denied) if not.
 */
export async function platformRpcStatus(page: Page): Promise<number> {
  const session = await page.evaluate(() => localStorage.getItem('qm.auth'));
  const { access_token } = JSON.parse(session ?? '{}') as { access_token?: string };
  const { url, anonKey } = supabaseEnv();
  const response = await fetch(`${url}/rest/v1/rpc/platform_health`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${access_token}`,
      'content-profile': 'api',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  return response.status;
}

/** On `/platform/mfa`: adds an authenticator app and reaches aal2. Returns the TOTP secret. */
export async function enrol(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
  await page.getByLabel('6-digit code').fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-step sign-in is on' })).toBeVisible();
  return secret;
}

/** A fresh operator, signed in on `page` with an aal2 session. */
export async function signedInOperator(page: Page): Promise<{ email: string; secret: string }> {
  const email = await newOperator();
  await signInTo(page, email, '/platform/mfa');
  return { email, secret: await enrol(page) };
}
