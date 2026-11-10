// N3 (#69): dispatcher with fake RPCs and a fake provider. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { createRegistry, DbChannelRegistry, defineChannel, failed, type OutboundMessage } from '@qm/providers';
import { unsubscribeToken } from '../_shared/unsubscribe-token.ts';
import {
  appOrigin,
  createDispatchHandler,
  type DispatchDeps,
  oneClickEndpoint,
  type OutboxJob,
  type OutboxReport,
  render,
} from './handler.ts';

const KEY = 'dispatch-secret-0123456789abcdef0123';
const ADDRESS = 'guest@example.com';
// Every email ends with the source offer (4-WL1).
const SOURCE = '\n\nPowered by QueueThat · Source code: https://github.com/queuethat/queuethat-oss';
const STOP_SECRET = 'unsubscribe-secret-0123456789abcdef';

function job(id: string, overrides: Partial<OutboxJob> = {}): OutboxJob {
  return {
    id, org_id: 'org-1', visit_id: 'visit-1', channel: 'email', category: 'transactional',
    template_key: 'called', template_version: 1, locale: 'en', subject: 'Turn {ticket}',
    body: 'It is your turn: {ticket}. Go to {counter}.', vars: { ticket: 'A001', counter: 'Chair 1' },
    recipient: { kind: 'address', value: ADDRESS }, has_consent: true, is_suppressed: false,
    location_tz: 'America/New_York', attempts: 0, status_url: null, ...overrides,
  };
}

function setup(
  batches: OutboxJob[][],
  opts: { reserve?: (id: string) => 'allowed' | 'cap_reached' | 'country_blocked' | 'budget_reached'; sms?: boolean; relevant?: (id: string) => boolean; fail?: boolean; secret?: string; stop?: boolean | 'page-only'; appUrl?: string } = {},
) {
  const sent: OutboundMessage[] = [];
  const reports = new Map<string, OutboxReport>();
  const logs: string[] = [];
  let claims = 0;
  const email = defineChannel({
    kind: 'email',
    providerName: 'fake',
    deliver(msg) {
      sent.push(msg);
      return Promise.resolve(opts.fail ? failed(true, 'http_503', 'busy') : { status: 'sent', providerMessageId: `m-${msg.outboxId}` });
    },
  });
  const reserved: string[] = [];
  const sms = defineChannel({
    kind: 'sms',
    providerName: 'fake',
    deliver(msg) {
      sent.push(msg);
      return Promise.resolve({ status: 'sent', providerMessageId: `m-${msg.outboxId}` });
    },
  });
  const deps: DispatchDeps = {
    reserve: (id) => {
      reserved.push(id);
      return Promise.resolve(opts.reserve?.(id) ?? 'allowed');
    },
    claim: () => Promise.resolve(batches[claims++] ?? []),
    stillRelevant: (id) => Promise.resolve(opts.relevant?.(id) ?? true),
    report: (id, result) => {
      if (id === 'report-breaks') return Promise.reject(new Error('rpc down'));
      reports.set(id, result);
      return Promise.resolve();
    },
    registry: createRegistry([email, sms]),
    secret: opts.secret ?? KEY,
    log: (line) => logs.push(line),
    appUrl: opts.appUrl,
    unsubscribe: opts.stop
      ? {
        secret: STOP_SECRET,
        page: 'https://site.test/u',
        endpoint: opts.stop === 'page-only' ? undefined : 'https://api.test/functions/v1/unsubscribe',
      }
      : undefined,
  };
  const handler = createDispatchHandler(deps);
  const run = (key = KEY) =>
    handler(new Request('http://x/', { method: 'POST', headers: { Authorization: `Bearer ${key}` } }));
  return { reserved, sent, reports, logs, run, handler, claims: () => claims };
}

Deno.test('only DISPATCH_SECRET may run it', async () => {
  const { run, handler, claims } = setup([[job('a')]]);
  assert.equal((await run('anon-key')).status, 401);
  assert.equal((await handler(new Request('http://x/'))).status, 405);
  assert.equal(claims(), 0);
  const weak = setup([[job('a')]], { secret: 'short' });
  assert.equal((await weak.run('short')).status, 401, 'a secret under 32 characters disables it');
});

Deno.test('renders the template and records the provider outcome', async () => {
  const { run, sent, reports } = setup([[job('a')]]);
  const res = await run();
  assert.deepEqual(await res.json(), { claimed: 1, sent: 1, failed: 0, suppressed: 0, gone: 0 });
  assert.equal(sent[0]?.text, 'It is your turn: A001. Go to Chair 1.' + SOURCE);
  assert.equal(sent[0]?.subject, 'Turn A001');
  assert.equal(sent[0]?.trigger, 'called');
  assert.deepEqual(reports.get('a'), { status: 'sent', provider: 'fake', provider_message_id: 'm-a', segments: undefined, cost_micros: undefined });
});

Deno.test('policy, relevance, recipient and channel problems never reach the provider', async () => {
  const { run, sent, reports } = setup(
    [[
      job('no-consent', { has_consent: false }),
      job('stale'),
      job('deleted', { recipient: null }),
      job('push', { channel: 'push', recipient: { kind: 'push', endpoint: 'e', p256dh: 'k', auth: 'a' } }),
      job('no-template', { body: null }),
    ]],
    { relevant: (id) => id !== 'stale' },
  );
  await run();
  assert.equal(sent.length, 0);
  assert.deepEqual(reports.get('no-consent'), { status: 'suppressed', provider: 'fake', error_code: 'no_consent' });
  assert.deepEqual(reports.get('stale'), { status: 'suppressed', error_code: 'not_relevant' });
  assert.deepEqual(reports.get('deleted'), { status: 'gone', error_code: 'recipient_deleted' });
  assert.deepEqual(reports.get('push'), { status: 'failed', retryable: false, error_code: 'no_channel' });
  assert.deepEqual(reports.get('no-template'), { status: 'failed', retryable: false, error_code: 'no_template' });
});

Deno.test('a retryable provider failure is reported as retryable', async () => {
  const { run, reports } = setup([[job('a')]], { fail: true });
  await run();
  assert.deepEqual(reports.get('a'), { status: 'failed', provider: 'fake', retryable: true, error_code: 'http_503' });
});

Deno.test('keeps claiming full batches, and one broken report does not stop the rest', async () => {
  const full = Array.from({ length: 50 }, (_, i) => job(`j${i}`));
  const { run, reports, claims } = setup([full, [job('report-breaks'), job('last')]]);
  const summary = await (await run()).json();
  assert.equal(claims(), 2);
  assert.equal(summary.claimed, 52);
  assert.equal(summary.sent, 51);
  assert.equal(reports.get('last')?.status, 'sent');
});

Deno.test('logs carry ids and outcomes, never addresses or message text', async () => {
  const { run, logs } = setup([[job('a'), job('report-breaks')]]);
  await run();
  assert.equal(logs.length, 2);
  for (const line of logs) {
    assert.ok(!line.includes(ADDRESS) && !line.includes('A001'), line);
  }
});

Deno.test('render fills known placeholders and blanks unknown ones', () => {
  assert.equal(render('{ticket} at {counter}{x}', { ticket: 'B7', counter: 3 }), 'B7 at 3');
});

Deno.test('render drops an optional [segment] whose placeholder has no value', () => {
  const called = "It's your turn: {ticket}. [Please go to {counter}.]";
  assert.equal(render(called, { ticket: 'A1', counter: 'Chair 2' }), "It's your turn: A1. Please go to Chair 2.");
  assert.equal(render(called, { ticket: 'A1' }), "It's your turn: A1.");
  assert.equal(render('Keep [this] text', {}), 'Keep [this] text');
});

Deno.test('guest email carries a signed stop link in the text and the List-Unsubscribe header', async () => {
  const { run, sent } = setup(
    [[
      job('a', { body: 'Turn {ticket}.[ Stop: {unsubscribe_url}]' }),
      job('account', { visit_id: null, body: 'Sign in.[ Stop: {unsubscribe_url}]' }),
    ]],
    { stop: true },
  );
  await run();
  const guest = sent.find((m) => m.outboxId === 'a')!;
  const token = await unsubscribeToken(STOP_SECRET, 'a');
  assert.equal(guest.text, `Turn A001. Stop: https://site.test/u?n=a&t=${token}` + SOURCE);
  assert.equal(guest.unsubscribeUrl, `https://api.test/functions/v1/unsubscribe?n=a&t=${token}`);
  const account = sent.find((m) => m.outboxId === 'account')!;
  assert.equal(account.text, 'Sign in.' + SOURCE, 'account mail has no stop link');
  assert.equal(account.unsubscribeUrl, undefined);
});

Deno.test('an appointment reminder email carries the stop link although it has no visit', async () => {
  const { run, sent } = setup(
    [[
      job('r', { visit_id: null, location_tz: null, template_key: 'appointment_reminder', body: 'Soon.[ Stop: {unsubscribe_url}]' }),
    ]],
    { stop: true },
  );
  await run();
  const token = await unsubscribeToken(STOP_SECRET, 'r');
  assert.equal(sent[0]!.text, `Soon. Stop: https://site.test/u?n=r&t=${token}` + SOURCE);
});

Deno.test('a guest incident notice carries the stop link although it has no visit', async () => {
  const { run, sent } = setup(
    [[
      job('g', { visit_id: null, location_tz: null, template_key: 'guest_incident_notice', body: 'Notice.[ Stop: {unsubscribe_url}]' }),
    ]],
    { stop: true },
  );
  await run();
  const token = await unsubscribeToken(STOP_SECRET, 'g');
  assert.equal(sent[0]!.text, `Notice. Stop: https://site.test/u?n=g&t=${token}` + SOURCE);
});

Deno.test('without an unsubscribe secret the optional stop sentence is dropped', async () => {
  const { run, sent } = setup([[job('a', { body: 'Turn {ticket}.[ Stop: {unsubscribe_url}]' })]]);
  await run();
  assert.equal(sent[0]?.text, 'Turn A001.' + SOURCE);
  assert.equal(sent[0]?.unsubscribeUrl, undefined);
});

Deno.test('the List-Unsubscribe endpoint is https only (RFC 8058)', () => {
  assert.equal(oneClickEndpoint('https://abc.supabase.co'), 'https://abc.supabase.co/functions/v1/unsubscribe');
  assert.equal(oneClickEndpoint('http://kong:8000'), undefined);
  assert.equal(oneClickEndpoint(undefined), undefined);
});

Deno.test('with no endpoint the stop link stays in the text and the header is left out', async () => {
  const { run, sent } = setup([[job('a', { body: 'Turn {ticket}.[ Stop: {unsubscribe_url}]' })]], {
    stop: 'page-only',
  });
  await run();
  assert.match(sent[0]!.text, /Stop: https:\/\/site\.test\/u\?n=a&t=/);
  assert.equal(sent[0]!.unsubscribeUrl, undefined);
});

const marketing = (id: string, vars: Record<string, unknown>) =>
  job(id, {
    category: 'marketing',
    // No zone means no quiet hours: these tests are about the footer and stop link, and must not
    // fail between 20:00 and 08:00 in New York (they did, nightly).
    location_tz: null,
    template_key: 'broadcast',
    body: '{message}[ Stop: {unsubscribe_url}]',
    vars: { message: 'Half price today', ...vars },
  });

Deno.test('marketing email carries the sender footer, an HTML part and both unsubscribe headers (AC1)', async () => {
  const { run, sent } = setup(
    [[marketing('m', { org_legal_name: 'Acme Ltd', org_postal_address: '1 Main St, Springfield' })]],
    { stop: true },
  );
  await run();
  const msg = sent[0]!;
  assert.match(msg.text, /Acme Ltd\n1 Main St, Springfield/);
  assert.match(msg.html!, /1 Main St, Springfield/);
  assert.match(msg.html!, /<a href="https:\/\/site\.test\/u\?n=m&#38;t=[\w-]+">Unsubscribe<\/a>/);
  assert.match(msg.unsubscribeUrl!, /^https:\/\/api\.test\/functions\/v1\/unsubscribe\?n=m&t=/);
});

Deno.test('marketing email without a postal address or a stop link is dead, never sent', async () => {
  const { run, sent, reports } = setup(
    [[marketing('nopost', { org_legal_name: 'Acme Ltd' }), marketing('nostop', { org_postal_address: '1 Main St' })]],
    { stop: true },
  );
  await run();
  assert.deepEqual(reports.get('nopost'), { status: 'failed', retryable: false, error_code: 'missing_postal_address' });
  assert.equal(sent.length, 1);
  const noStop = setup([[marketing('nostop', { org_postal_address: '1 Main St' })]]);
  await noStop.run();
  assert.equal(noStop.reports.get('nostop')?.error_code, 'missing_unsubscribe');
  assert.equal(noStop.sent.length, 0);
});

Deno.test('a transactional called email needs no footer and escapes guest text in HTML (AC4)', async () => {
  const { run, sent } = setup([[job('c', { vars: { ticket: '<b>A1</b>', counter: 'x' } })]], { stop: true });
  await run();
  assert.doesNotMatch(sent[0]!.text, /--\n/);
  assert.match(sent[0]!.html!, /&#60;b&#62;A1&#60;\/b&#62;/);
  assert.doesNotMatch(sent[0]!.html!, /<b>/);
});

Deno.test('every email links the source; the product name goes when the org hides branding (4-WL1)', async () => {
  const { run, sent } = setup([[
    job('shown', { vars: { ticket: 'A1', org_hide_product_branding: false } }),
    job('hidden', { vars: { ticket: 'A2', org_hide_product_branding: true } }),
  ]]);
  await run();
  const [shown, hidden] = [sent.find((m) => m.outboxId === 'shown')!, sent.find((m) => m.outboxId === 'hidden')!];
  assert.match(shown.text, /Powered by QueueThat · Source code: https:\/\/github\.com\//);
  assert.doesNotMatch(hidden.text, /QueueThat/);
  assert.doesNotMatch(hidden.html!, /QueueThat/);
  assert.match(hidden.text, /Source code: https:\/\/github\.com\//);
  assert.match(hidden.html!, /<a href="https:\/\/github\.com\/[^"]+">Source code<\/a>/);
});

Deno.test('two orgs: the one with settings sends through its provider, the other is suppressed channel_disabled', async () => {
  const sent: OutboundMessage[] = [];
  const reports = new Map<string, OutboxReport>();
  const logs: string[] = [];
  const SECRET = 'tok_org_a_secret_1234';
  const PHONE = '+15005550006';
  const twilio = (secret: string) =>
    defineChannel({
      kind: 'sms',
      providerName: 'twilio',
      deliver(msg) {
        sent.push(msg);
        return Promise.resolve({ status: 'sent', providerMessageId: `m-${msg.outboxId}-${secret.length}` });
      },
    });
  const handler = createDispatchHandler({
    reserve: () => Promise.resolve('allowed'),
    claim: (() => {
      let n = 0;
      return () =>
        Promise.resolve(n++ === 0
          ? [
            job('a', { org_id: 'org-a', channel: 'sms', recipient: { kind: 'address', value: PHONE } }),
            job('b', { org_id: 'org-b', channel: 'sms', recipient: { kind: 'address', value: PHONE } }),
          ]
          : []);
    })(),
    stillRelevant: () => Promise.resolve(true),
    report: (id, result) => {
      reports.set(id, result);
      return Promise.resolve();
    },
    registry: () =>
      new DbChannelRegistry({
        fetchConfig: (orgId) =>
          Promise.resolve(
            orgId === 'org-a'
              ? { provider: 'twilio', mode: 'own', config: {}, secrets: { auth_token: SECRET }, enabled: true }
              : { provider: null, mode: null, config: null, secrets: null, enabled: false },
          ),
        factories: { twilio: (s) => twilio(s.secrets.auth_token!) },
        local: createRegistry([]),
        localOnly: false,
      }),
    secret: KEY,
    log: (line) => logs.push(line),
  });
  await handler(new Request('http://x/', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } }));
  assert.deepEqual(sent.map((m) => m.orgId), ['org-a']);
  assert.equal(reports.get('a')?.status, 'sent');
  assert.equal(reports.get('a')?.provider, 'twilio');
  assert.deepEqual(reports.get('b'), { status: 'suppressed', error_code: 'channel_disabled' });
  assert.ok(!logs.join('\n').includes(SECRET) && !logs.join('\n').includes(PHONE), 'no secret or phone number in the logs');
});

Deno.test('a paid send the limits refuse never reaches the provider', async () => {
  const sms = (id: string) => job(id, { channel: 'sms', recipient: { kind: 'address', value: '+447700900123' } });
  const { run, sent, reports, reserved } = setup([[sms('over'), sms('ok')]], {
    reserve: (id) => (id === 'over' ? 'cap_reached' : 'allowed'),
  });
  await run();
  assert.deepEqual(reports.get('over'), { status: 'suppressed', error_code: 'cap_reached' });
  assert.equal(reports.get('ok')?.status, 'sent');
  assert.deepEqual(sent.map((m) => m.outboxId), ['ok']);
  assert.deepEqual(reserved.sort(), ['ok', 'over']);
});

Deno.test('email and rows without consent are not reserved', async () => {
  const { run, reserved } = setup([[job('mail'), job('noc', { channel: 'sms', has_consent: false })]]);
  await run();
  assert.deepEqual(reserved, []);
});

Deno.test('account mail can link into the app; guest mail and stored vars cannot', async () => {
  const body = 'Usage.[ Open: {app_url}/admin/usage]';
  const { run, sent } = setup(
    [[
      job('acct', { visit_id: null, body }),
      job('guest', { body, vars: { app_url: 'https://evil.test' } }),
      job('acct2', { visit_id: null, body, vars: { app_url: 'https://evil.test' } }),
    ]],
    { appUrl: 'https://app.test' },
  );
  await run();
  assert.equal(sent.find((m) => m.outboxId === 'acct')!.text, 'Usage. Open: https://app.test/admin/usage' + SOURCE);
  assert.equal(sent.find((m) => m.outboxId === 'guest')!.text, 'Usage.' + SOURCE, 'guest mail never gets the app link');
  assert.equal(sent.find((m) => m.outboxId === 'acct2')!.text, 'Usage. Open: https://app.test/admin/usage' + SOURCE, 'a stored app_url is ignored');
});

Deno.test('an appointment email links to its one-off manage path; stored vars cannot', async () => {
  const body = 'Booked.[ Change: {manage_url}][ Not you? {cancel_url}]';
  const mk = (id: string, extra: Partial<OutboxJob> = {}) =>
    job(id, { visit_id: null, location_tz: null, template_key: 'appointment_confirmed', body, status_url: '/a/tok-1', ...extra });
  const { run, sent } = setup(
    [[mk('a'), mk('b', { vars: { manage_url: 'https://evil.test' } }), mk('c', { status_url: null }), mk('d', { status_url: 'https://evil.test/a/x' })]],
    { appUrl: 'https://app.test' },
  );
  await run();
  const text = (id: string) => sent.find((m) => m.outboxId === id)!.text;
  assert.equal(text('a'), 'Booked. Change: https://app.test/a/tok-1 Not you? https://app.test/a/tok-1?cancel=1' + SOURCE);
  assert.equal(text('b'), text('a'), 'a stored manage_url is ignored');
  assert.equal(text('c'), 'Booked.' + SOURCE, 'no minted path, no links');
  assert.equal(text('d'), 'Booked.' + SOURCE, 'only a /a/ path on our own origin is linked');
});

Deno.test('without PUBLIC_URL the app link sentence is dropped', async () => {
  const { run, sent } = setup([[job('acct', { visit_id: null, body: 'Usage.[ Open: {app_url}/admin/usage]' })]]);
  await run();
  assert.equal(sent[0]!.text, 'Usage.' + SOURCE);
});

Deno.test('appOrigin keeps only an https origin', () => {
  assert.equal(appOrigin('https://app.queuethat.com/'), 'https://app.queuethat.com');
  assert.equal(appOrigin('http://localhost:5173'), undefined);
  assert.equal(appOrigin(' '), undefined);
  assert.equal(appOrigin('not a url'), undefined);
  assert.equal(appOrigin(undefined), undefined);
});
