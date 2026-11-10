// The platform:revoke command, apart from its entry point so it can be tested.
import { CliError, findUser, type Call } from './platform-cli.ts';

const USAGE = 'Usage: pnpm platform:revoke <email> [--allow-last-operator]';

/** Runs the command; returns the line to print. Exported for tests. */
export async function revoke(args: string[], call: Call): Promise<string> {
  const flags = args.filter((a) => a.startsWith('--'));
  const [email, ...extra] = args.filter((a) => !a.startsWith('--'));
  if (!email || extra.length > 0 || flags.some((f) => f !== '--allow-last-operator'))
    throw new CliError(USAGE);
  const allowLast = flags.includes('--allow-last-operator');

  const user = await findUser(call, email);
  if (!user) throw new CliError(`No user with email ${email}. Nothing changed.`);

  let result: { revoked: boolean; previous_role: string | null; sessions: number };
  try {
    result = (await call('/rest/v1/rpc/platform_revoke_role', {
      method: 'POST',
      headers: { 'Content-Profile': 'api' },
      body: JSON.stringify({ p_user_id: user.id, p_allow_last_operator: allowLast }),
    })) as typeof result;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('last_operator'))
      throw new CliError(
        `${email} is the only operator, so nobody would be left to run the platform. Grant another ` +
          'operator first (pnpm platform:grant), or repeat with --allow-last-operator. Nothing changed.',
      );
    throw error;
  }

  const sessions = `${result.sessions} session${result.sessions === 1 ? '' : 's'} ended`;
  return result.revoked
    ? `${email} no longer has platform role ${result.previous_role}; ${sessions}. ` +
        'Recorded in app.platform_audit.'
    : `${email} has no platform role. Nothing to remove; ${sessions}.`;
}
