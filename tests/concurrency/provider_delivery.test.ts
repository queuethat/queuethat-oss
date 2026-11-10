// #920: an outbox row for an org with verified, enabled provider settings goes out through that
// provider's adapter, end to end: api.set_provider_settings (Vault) -> api.set_channel_enabled (the
// gate) -> api.claim_outbox -> DbChannelRegistry + the real factories -> api.get_channel_config ->
// api.reserve_send -> the adapter's HTTP call to a local fake -> api.report_outbox_result.
// Only the provider's origin is faked, and only through the deployment-side `apiBase` option.
// It lives with the database tests because it needs the global compliance flag, which the browser
// specs read; the flag is restored before the file ends.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegistry, DbChannelRegistry } from '../../packages/providers/src/index.ts';
import {
  dispatch,
  type OutboxJob,
} from '../../supabase/functions/dispatch-notifications/handler.ts';
import { providerFactories } from '../../supabase/functions/dispatch-notifications/factories.ts';
import { asStaff, connect, createWorld, join, type Sql } from './db';
import { randomUUID } from 'node:crypto';

interface Seen {
  provider: string;
  path: string;
  authorization: string | undefined;
  body: string;
}
const seen: Seen[] = [];
let origin = '';
let server: ReturnType<typeof createServer>;
let admin: Sql;
let guestPool: Sql;
let flagBefore: Date | null = null;

/** Each provider's success reply, keyed by the path its adapter calls. */
function reply(path: string): { provider: string; json: unknown } | null {
  if (/^\/2010-04-01\/Accounts\/AC\w+\/Messages\.json$/.test(path)) {
    return {
      provider: 'twilio',
      json: { sid: 'SMfake-twilio', num_segments: '1', status: 'queued' },
    };
  }
  if (path === '/v2/messages')
    return { provider: 'telnyx', json: { data: { id: 'telnyx-fake-id', parts: 1 } } };
  if (path === '/v1/messages')
    return { provider: 'vonage', json: { message_uuid: 'vonage-fake-id' } };
  if (/^\/v1\/Account\/\w+\/Message\/$/.test(path)) {
    return { provider: 'plivo', json: { message_uuid: ['plivo-fake-id'] } };
  }
  if (path === '/email')
    return { provider: 'postmark', json: { MessageID: 'postmark-fake-id', ErrorCode: 0 } };
  if (path === '/emails') return { provider: 'resend', json: { id: 'resend-fake-id' } };
  if (/^\/v\d+\.\d+\/\d+\/messages$/.test(path)) {
    return { provider: 'meta', json: { messages: [{ id: 'wamid.fake' }] } };
  }
  return null;
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', origin).pathname;
      const hit = reply(path);
      if (!hit) {
        res.writeHead(404).end('{}');
        return;
      }
      seen.push({
        provider: hit.provider,
        path,
        authorization:
          req.headers.authorization ??
          (req.headers['x-postmark-server-token'] as string | undefined),
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(hit.provider === 'twilio' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(hit.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  admin = connect(2);
  guestPool = connect(1);
  const [flags] = await admin<
    { at: Date | null }[]
  >`select compliance_gate_passed_at as at from app.platform_flags`;
  flagBefore = flags?.at ?? null;
  await admin`update app.platform_flags set compliance_gate_passed_at = now()`;
});

afterAll(async () => {
  await admin`update app.platform_flags set compliance_gate_passed_at = ${flagBefore}`;
  await Promise.all([admin.end(), guestPool.end()]);
  await new Promise((resolve) => server.close(resolve));
});

interface Setup {
  channel: 'sms' | 'email' | 'whatsapp';
  provider: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
  /** The settings are saved, but the owner never switches the channel on. */
  stayOff?: boolean;
  /** No settings at all. */
  noSettings?: boolean;
  /** WhatsApp: the guest's window is closed, so only the approved template may go out. */
  template?: boolean;
}

/** One org with a waiting guest and one queued `called` message on `channel`. Returns ids to dispatch. */
async function orgWithMessage(s: Setup) {
  const world = await createWorld(admin);
  // a fresh address each time: the platform caps messages per address per day
  const phone = `+1415${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const email = `gina-${randomUUID().slice(0, 8)}@example.com`;
  const owner = world.staff[0];
  await admin`update app.memberships set role = 'owner' where org_id = ${world.orgId} and user_id = ${owner}`;
  if (!s.noSettings) {
    await asStaff(
      admin,
      owner,
      (tx) => tx`
      select api.set_provider_settings(${world.orgId}, ${s.channel}, ${s.provider}, 'own',
        ${tx.json(s.config)}, ${tx.json(s.secrets)}, ${randomUUID()})`,
    );
    await admin`update app.provider_settings set verified_at = now() where org_id = ${world.orgId}`;
    // SMS needs the business's recorded privacy contact (C7)
    await admin`insert into app.org_privacy (org_id, officer_name, email, jurisdiction)
                values (${world.orgId}, 'Pat Privacy', 'privacy@example.test', 'ca')
                on conflict (org_id) do nothing`;
    if (s.channel !== 'email') {
      await admin`insert into app.channel_limits (org_id, channel, daily_cap, country_allowlist)
                  values (${world.orgId}, ${s.channel}, 200, '{US}')
                  on conflict (org_id, channel) do update set daily_cap = 200, country_allowlist = '{US}'`;
    }
    if (!s.stayOff) {
      // the real gate: a missing prerequisite would raise channel_prerequisite_missing here
      await asStaff(
        admin,
        owner,
        (tx) => tx`
        select api.set_channel_enabled(${world.orgId}, ${s.channel}, true, ${randomUUID()})`,
      );
    }
  }
  await join(guestPool, world.queueId);
  const [visit] = await admin<
    { id: string }[]
  >`select id from app.visits where queue_id = ${world.queueId}`;
  const [guest] = await admin<{ id: string }[]>`
    insert into app.guests (org_id, first_name) values (${world.orgId}, 'Gina') returning id`;
  const [contact] = await admin<{ id: string }[]>`
    insert into app.guest_contacts (org_id, guest_id, channel, value, country_code, created_source, whatsapp_window_until)
    values (${world.orgId}, ${guest!.id}, ${s.channel === 'email' ? 'email' : 'phone'},
            ${s.channel === 'email' ? email : phone}, 'US', 'online',
            -- WhatsApp free text is allowed while the guest's 24 h window is open (template mode: #922-follow-up)
            ${s.channel === 'whatsapp' && !s.template ? new Date(Date.now() + 3_600_000) : null}) returning id`;
  await admin`insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
              values (${world.orgId}, ${contact!.id}, ${s.channel}, 'transactional', 'granted', 'online', '1', 'h')`;
  if (s.channel !== 'email') {
    const [tpl] = await admin<{ id: string }[]>`
      insert into app.notification_templates (org_id, trigger, channel, body)
      values (${world.orgId}, 'called', ${s.channel}, 'Hi {{guest_first_name}}, it is your turn: {{ticket}}') returning id`;
    if (s.template) {
      await admin`insert into app.whatsapp_templates (org_id, template_id, wa_name, wa_language, wa_category, status)
                  values (${world.orgId}, ${tpl!.id}, 'turn_called', 'en_US', 'utility', 'approved')`;
    }
  }
  const [row] = await admin<{ id: string }[]>`
    insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
    values (${world.orgId}, ${visit!.id}, ${s.channel}, ${contact!.id}, 'called', 1, ${'pd-' + randomUUID()})
    returning id`;
  return { orgId: world.orgId, outboxId: row!.id, phone, email };
}

/** Runs the real dispatcher over exactly these outbox rows, with the real RPCs. */
async function dispatchRows(ids: string[]) {
  const reports: Record<
    string,
    { status: string; error_code?: string; provider?: string; provider_message_id?: string }
  > = {};
  const logs: string[] = [];
  const asService = <T>(fn: (tx: Parameters<Parameters<Sql['begin']>[1]>[0]) => Promise<T>) =>
    admin.begin(async (tx) => {
      await tx.unsafe('set local role service_role');
      return fn(tx);
    }) as Promise<T>;
  await dispatch({
    async claim(limit, leaseSeconds) {
      // Other tests' rows share the outbox: page past them until this test's rows are claimed.
      const mine: OutboxJob[] = [];
      for (let page = 0; page < 40 && mine.length < ids.length; page++) {
        const rows = await asService(
          (tx) => tx<OutboxJob[]>`select * from api.claim_outbox(${limit}, ${leaseSeconds})`,
        );
        mine.push(...rows.filter((r) => ids.includes(r.id!)));
        if (rows.length < limit) break;
      }
      return mine;
    },
    stillRelevant: () => Promise.resolve(true),
    async whatsapp(id) {
      const [row] = await asService((tx) => tx`select * from api.get_whatsapp_send(${id})`);
      return (row ?? null) as never;
    },
    async reserve(id) {
      const [r] = await asService(
        (tx) => tx<{ decision: 'allowed' }[]>`select decision from api.reserve_send(${id})`,
      );
      return r!.decision;
    },
    async report(id, result) {
      reports[id] = result;
      await asService(
        (tx) => tx`select api.report_outbox_result(${id}, ${tx.json(result as never)})`,
      );
    },
    registry: () =>
      new DbChannelRegistry({
        async fetchConfig(orgId, kind) {
          const [row] = await asService(
            (tx) =>
              tx`select provider, mode, config, secrets, enabled from api.get_channel_config(${orgId}, ${kind})`,
          );
          return row as never;
        },
        factories: providerFactories({
          functionsUrl: 'https://functions.example.test/functions/v1',
          apiBase: Object.fromEntries(
            ['twilio', 'telnyx', 'vonage', 'plivo', 'postmark', 'resend', 'meta'].map((n) => [
              n,
              origin,
            ]),
          ),
        }),
        local: createRegistry([]),
        localOnly: false,
      }),
    secret: 'unused-by-dispatch-0123456789abcdef',
    log: (line) => logs.push(line),
  });
  return { reports, logs };
}

const cases: (Setup & {
  id: string;
  check: (s: Seen, to: { phone: string; email: string }) => void;
})[] = [
  {
    id: 'SMfake-twilio',
    channel: 'sms',
    provider: 'twilio',
    config: {
      account_sid: `AC${'a'.repeat(32)}`,
      messaging_service_sid: 'MGfake',
      from_number: '+14155550100',
      messaging_campaign_ref: 'CMP1',
    },
    secrets: { auth_token: 'twilio-token-0123456789' },
    check: (s, to) => {
      expect(s.authorization).toBe(`Basic ${btoa(`AC${'a'.repeat(32)}:twilio-token-0123456789`)}`);
      expect(decodeURIComponent(s.body)).toContain(`To=${to.phone}`);
    },
  },
  {
    id: 'telnyx-fake-id',
    channel: 'sms',
    provider: 'telnyx',
    config: {
      messaging_profile_id: 'prof-1',
      from_number: '+14155550100',
      messaging_campaign_ref: 'CMP1',
    },
    secrets: { api_key: 'telnyx-key-0123456789', webhook_secret: 'cHVibGljLWtleQ==' },
    check: (s, to) => {
      expect(s.authorization).toBe('Bearer telnyx-key-0123456789');
      expect(JSON.parse(s.body)).toMatchObject({ to: to.phone, messaging_profile_id: 'prof-1' });
    },
  },
  {
    id: 'vonage-fake-id',
    channel: 'sms',
    provider: 'vonage',
    config: { from_number: '+14155550100', messaging_campaign_ref: 'CMP1' },
    secrets: {
      api_key: 'abcd1234',
      api_secret: 'vonage-secret-0123',
      signing_secret: 'sig-secret-0123456',
    },
    check: (s, to) => {
      expect(s.authorization).toBe(`Basic ${btoa('abcd1234:vonage-secret-0123')}`);
      expect(JSON.parse(s.body)).toMatchObject({ to: to.phone.slice(1), from: '+14155550100' });
    },
  },
  {
    id: 'plivo-fake-id',
    channel: 'sms',
    provider: 'plivo',
    config: {
      auth_id: 'MAABCDEFGHIJKL',
      from_number: '+14155550100',
      messaging_campaign_ref: 'CMP1',
    },
    secrets: { auth_token: 'plivo-token-0123456789' },
    check: (s, to) => {
      expect(s.authorization).toBe(`Basic ${btoa('MAABCDEFGHIJKL:plivo-token-0123456789')}`);
      expect(JSON.parse(s.body)).toMatchObject({ dst: to.phone.slice(1) });
    },
  },
  {
    id: 'postmark-fake-id',
    channel: 'email',
    provider: 'postmark',
    config: { sender_email: 'shop@example.com' },
    secrets: { api_key: 'postmark-key-0123456789' },
    check: (s, to) => {
      expect(s.authorization).toBe('postmark-key-0123456789');
      expect(JSON.parse(s.body)).toMatchObject({ To: to.email });
    },
  },
  {
    id: 'resend-fake-id',
    channel: 'email',
    provider: 'resend',
    config: { sender_email: 'shop@example.com' },
    secrets: { api_key: 're_0123456789abcdef' },
    check: (s, to) => {
      expect(s.authorization).toBe('Bearer re_0123456789abcdef');
      expect(JSON.parse(s.body)).toMatchObject({ to: [to.email] });
    },
  },
  {
    id: 'wamid.fake',
    channel: 'whatsapp',
    provider: 'meta',
    config: { phone_number_id: '106540352242922' },
    secrets: { access_token: 'EAAG-0123456789', app_secret: 'app-secret-0123' },
    check: (s, to) => {
      expect(s.authorization).toBe('Bearer EAAG-0123456789');
      expect(JSON.parse(s.body)).toMatchObject({ to: to.phone.slice(1) });
    },
  },
];

describe('provider settings reach the sending path', () => {
  for (const c of cases) {
    it(`${c.channel}/${c.provider}: a verified, enabled org's message goes out through its own account`, async () => {
      const { orgId, outboxId, ...to } = await orgWithMessage(c);
      seen.length = 0;
      const { reports, logs } = await dispatchRows([outboxId]);

      expect(reports[outboxId], logs.join(' | ')).toMatchObject({
        status: 'sent',
        provider_message_id: c.id,
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.provider).toBe(c.provider);
      c.check(seen[0]!, to);

      const [row] = await admin<{ status: string; provider: string; reserved_at: Date | null }[]>`
        select status, provider, reserved_at from app.notifications where id = ${outboxId}`;
      expect(row).toMatchObject({ status: 'sent' });
      // paid channels pass the cap check first; email has no cap
      expect(row!.reserved_at !== null).toBe(c.channel !== 'email');
      // no credential reaches a log line, a report or the row
      for (const secret of Object.values(c.secrets)) {
        expect(JSON.stringify([logs, reports[outboxId]])).not.toContain(secret);
      }
      expect(orgId).toBeTruthy();
    });
  }

  it('whatsapp outside the 24 h window sends the approved template with the message values', async () => {
    const meta = cases.find((c) => c.provider === 'meta')!;
    const { outboxId } = await orgWithMessage({ ...meta, template: true });
    seen.length = 0;
    const { reports } = await dispatchRows([outboxId]);
    expect(reports[outboxId]).toMatchObject({ status: 'sent', provider_message_id: 'wamid.fake' });
    const body = JSON.parse(seen[0]!.body);
    expect(body).toMatchObject({
      type: 'template',
      template: { name: 'turn_called', language: { code: 'en_US' } },
    });
    expect(body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual([
      'there',
      expect.any(String),
    ]);
  });

  it('an org with no settings, and one that never switched the channel on, send nothing and end suppressed', async () => {
    const none = await orgWithMessage({
      channel: 'sms',
      provider: 'twilio',
      config: {},
      secrets: {},
      noSettings: true,
    });
    const off = await orgWithMessage({ ...cases[0]!, stayOff: true });
    seen.length = 0;
    const { reports } = await dispatchRows([none.outboxId, off.outboxId]);
    expect(reports[none.outboxId]).toMatchObject({
      status: 'suppressed',
      error_code: 'channel_disabled',
    });
    expect(reports[off.outboxId]).toMatchObject({
      status: 'suppressed',
      error_code: 'channel_disabled',
    });
    expect(seen).toHaveLength(0);
  });

  it('settings that cannot build a channel end the row instead of re-leasing it forever', async () => {
    // enabled through the real gate, then the account id is damaged in storage
    const org = await orgWithMessage(cases[0]!);
    await admin`update app.provider_settings set config = config || '{"account_sid":"broken"}' where org_id = ${org.orgId}`;
    seen.length = 0;
    const { reports } = await dispatchRows([org.outboxId]);
    expect(reports[org.outboxId]).toMatchObject({
      status: 'suppressed',
      error_code: 'channel_disabled',
    });
    expect(seen).toHaveLength(0);
  });

  it('config planted by an org cannot redirect the API call or the delivery-report endpoint', async () => {
    const org = await orgWithMessage({
      ...cases[0]!,
      config: { ...cases[0]!.config, apiBase: 'https://evil.test', endpoint_id: 'x' },
    });
    const [stored] = await admin<{ endpoint_id: string }[]>`
      select endpoint_id from app.provider_settings where org_id = ${org.orgId}`;
    seen.length = 0;
    await dispatchRows([org.outboxId]);
    expect(seen).toHaveLength(1); // went to the deployment's origin, not evil.test
    expect(decodeURIComponent(seen[0]!.body)).toContain(
      `StatusCallback=https://functions.example.test/functions/v1/provider-webhook/twilio/${stored!.endpoint_id}`,
    );
  });
});
