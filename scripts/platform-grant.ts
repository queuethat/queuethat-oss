// Grants a platform role (PLT1, #407): `pnpm platform:grant <email> [operator|support]`.
//
// The only way a platform role is created: no RPC or UI grants one (technical-design.md 3.6).
// Uses the service role, so it runs on the maintainer's machine only, never in the browser or CI.
// The audit trigger on app.platform_roles writes the platform_audit row.
//
//   local:  reads the URL and service role key from `supabase status`
//   pilot:  SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... pnpm platform:grant <email>
// To remove a role and end the person's sessions: `pnpm platform:revoke <email>`.
import { CliError, client, connection, findUser, runCli } from './lib/platform-cli.ts';

const ROLES = ['operator', 'support'] as const;
type PlatformRole = (typeof ROLES)[number];

await runCli(async () => {
  const [email, roleArg = 'operator'] = process.argv.slice(2);
  if (!email || !ROLES.includes(roleArg as PlatformRole))
    throw new CliError('Usage: pnpm platform:grant <email> [operator|support]');
  const role = roleArg as PlatformRole;
  const call = client(connection());

  const user = await findUser(call, email);
  if (!user)
    throw new CliError(`No user with email ${email}. They must sign up (or be invited) first.`);

  // A role holder without a verified authenticator app could be taken over by whoever signs in
  // with their password and enrols first (#541 security review), so the app comes first.
  const factors = (await call(`/auth/v1/admin/users/${user.id}/factors`)) as {
    factor_type: string;
    status: string;
  }[];
  if (!factors.some((f) => f.factor_type === 'totp' && f.status === 'verified'))
    throw new CliError(
      `${email} has no verified authenticator app. Ask them to sign in and set one up at ` +
        '/platform/mfa, then run this again.',
    );

  const app = { 'Accept-Profile': 'app', 'Content-Profile': 'app' };
  const [current] = (await call(`/rest/v1/platform_roles?user_id=eq.${user.id}&select=role`, {
    headers: app,
  })) as { role: PlatformRole }[];
  if (current?.role === role) {
    console.log(`${email} already has platform role ${role}. Nothing changed.`);
    return;
  }

  await call(
    current ? `/rest/v1/platform_roles?user_id=eq.${user.id}` : '/rest/v1/platform_roles',
    {
      method: current ? 'PATCH' : 'POST',
      headers: { ...app, Prefer: 'return=minimal' },
      body: JSON.stringify(
        current ? { role, granted_at: new Date().toISOString() } : { user_id: user.id, role },
      ),
    },
  );
  console.log(
    `${email} now has platform role ${role}${current ? ` (was ${current.role})` : ''}. ` +
      'Recorded in app.platform_audit.',
  );
});
