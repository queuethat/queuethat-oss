// 2A-TM1 (#95): invite-staff. Creates an invitation as the caller (their JWT, so the database
// decides who may invite whom) and then has Supabase Auth email the invitee a link to
// /auth/accept-invite. It is an Edge Function because it needs the Auth admin API and SMTP
// (technical-design.md 3.5, rule 3). Everything that touches Supabase is injected.
//
// POST { org_id, email, role, location_ids?, display_name?, idempotency_key? }   Authorization: Bearer <user JWT>
//   200 { invitation, sent }   sent is false when this was an idempotent replay (no token, no mail)
//   400 invalid_input · 401 not_authenticated · 403 permission_denied / forbidden_role / org_suspended
//   402 plan_limit_reached { error, limit } (the plan's seat count) · 404 not_found · 429 rate_limited · 502 send_failed (the invitation is revoked again) · 500 unknown
// Logs carry fixed words and ids only: never the email address or the token.

export interface Invitation {
  id: string;
  org_id: string;
  email: string;
  role: string;
  location_ids: string[] | null;
  display_name: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  token: string | null;
}

export interface InviteInput {
  org_id: string;
  email: string;
  role: string;
  location_ids: string[] | null;
  display_name: string | null;
  idempotency_key: string;
}

/** What the invite email says about who is inviting to what. Already cleaned by `mailSafe`. */
export interface InviteContext {
  orgName: string | null;
  inviterName: string | null;
}

/**
 * Makes a name safe to put in an email we send: no markup or template characters (apostrophes and ampersands stay: they are harmless in text), one line, at
 * most 80 characters. A business owner chooses these names, and the mail comes from our domain.
 */
export function mailSafe(value: string | null | undefined): string | null {
  const clean = (value ?? '')
    .replace(/[<>"`{}\\\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return clean === '' ? null : clean;
}

/** A database error carrying one of the stable codes in packages/domain/src/errors.ts. */
export class DbError extends Error {
  /** The error detail; for plan_limit_reached it is the plan's seat limit. */
  constructor(message: string, readonly detail?: string) {
    super(message);
  }
}

export interface InviteStaffDeps {
  /** The public origin of the web app; the invite link points at `${siteUrl}/auth/accept-invite`. */
  siteUrl: string;
  /** api.create_invitation as the caller. Throws DbError. */
  createInvitation(jwt: string, input: InviteInput): Promise<Invitation>;
  /** api.revoke_invitation as the caller; used to undo an invitation whose mail could not be sent. */
  revokeInvitation(jwt: string, id: string): Promise<void>;
  /** The business name and the inviter's name (null when unknown), read as the caller. Must not throw. */
  inviteContext(jwt: string, orgId: string): Promise<InviteContext>;
  /** Auth invite for an unknown address, a magic link for an existing user. */
  sendInvite(
    email: string,
    redirectTo: string,
    displayName: string | null,
    context: InviteContext,
  ): Promise<void>;
  log?(line: string, cause: unknown): void;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const STATUS: Record<string, number> = {
  invalid_input: 400,
  not_authenticated: 401,
  permission_denied: 403,
  forbidden_role: 403,
  org_suspended: 403,
  plan_limit_reached: 402,
  not_found: 404,
  rate_limited: 429,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse(body: Record<string, unknown> | null): InviteInput | null {
  if (!body || typeof body.org_id !== 'string' || !UUID.test(body.org_id)) return null;
  if (typeof body.email !== 'string' || typeof body.role !== 'string') return null;
  const ids = body.location_ids ?? null;
  if (ids !== null && !(Array.isArray(ids) && ids.every((l) => typeof l === 'string' && UUID.test(l)))) return null;
  const name = body.display_name ?? null;
  if (name !== null && typeof name !== 'string') return null;
  const key = body.idempotency_key ?? crypto.randomUUID();
  if (typeof key !== 'string' || !UUID.test(key)) return null;
  return {
    org_id: body.org_id,
    email: body.email,
    role: body.role,
    location_ids: ids as string[] | null,
    display_name: name,
    idempotency_key: key,
  };
}

export function createInviteStaffHandler(deps: InviteStaffDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});

  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'invalid_input' });

    const jwt = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!jwt) return json(401, { error: 'not_authenticated' });
    const input = parse(await req.json().catch(() => null));
    if (!input) return json(400, { error: 'invalid_input' });

    let invitation: Invitation;
    try {
      invitation = await deps.createInvitation(jwt, input);
    } catch (error) {
      const code = error instanceof DbError ? error.message : 'unknown';
      if (!(code in STATUS)) log(`create_invitation failed for org ${input.org_id}`, error);
      const limit = code === 'plan_limit_reached' && error instanceof DbError ? Number(error.detail) : NaN;
      return json(STATUS[code] ?? 500, {
        error: code in STATUS ? code : 'unknown',
        ...(Number.isInteger(limit) ? { limit } : {}),
      });
    }
    if (!invitation.token) return json(200, { invitation, sent: false });

    const { token, ...safe } = invitation;
    const redirectTo = `${deps.siteUrl.replace(/\/$/, '')}/auth/accept-invite?token=${encodeURIComponent(token)}`;
    const context = await deps.inviteContext(jwt, invitation.org_id).catch(() => ({
      orgName: null,
      inviterName: null,
    }));
    try {
      await deps.sendInvite(invitation.email, redirectTo, invitation.display_name, {
        orgName: mailSafe(context.orgName),
        inviterName: mailSafe(context.inviterName),
      });
    } catch (error) {
      log(`sending invitation ${invitation.id} failed`, error);
      await deps.revokeInvitation(jwt, invitation.id).catch((e) => log(`revoking invitation ${invitation.id} failed`, e));
      return json(502, { error: 'send_failed' });
    }
    return json(200, { invitation: { ...safe, token: null }, sent: true });
  };
}
