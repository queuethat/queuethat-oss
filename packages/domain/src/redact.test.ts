import { describe, expect, it } from 'vitest';
import { redactDeep, redactText, withoutFreeText } from './redact.ts';

describe('redactText', () => {
  it.each([
    ['an E.164 number', 'sms failed for +447700900123', 'sms failed for [phone]'],
    ['a spaced national number', 'call 07700 900 123 now', 'call [phone] now'],
    ['a bracketed US number', 'to (415) 555-0132.', 'to [phone].'],
    ['an email', 'bounce from ana.p+q@example.co.uk', 'bounce from [email]'],
    [
      'a guest link',
      'GET https://q.test/v/ahEwp8ulm4XZU6Rt41F3 404',
      'GET https://q.test/v/[token] 404',
    ],
    [
      'an appointment link',
      'GET https://q.test/a/ahEwp8ulm4XZU6Rt41F3 404',
      'GET https://q.test/a/[token] 404',
    ],
    ['a secret query parameter', '/u?t=abc123&x=1', '/u?t=[redacted]&x=1'],
    [
      'an auth fragment',
      '/auth/callback#access_token=eyJx',
      '/auth/callback#access_token=[redacted]',
    ],
    ['a JWT', 'Bearer eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl', 'Bearer [jwt]'],
    [
      'a bare token, as a query hash embeds it',
      'query ["visit","ahEwp8ulm4XZU6Rt41F3tTQMnk5xFXH0Y0348QrvtfY"] failed',
      'query ["visit","[secret]"] failed',
    ],
    ['a percent-encoded phone', 'q=%2B447700900123', 'q=[phone]'],
    ['a phone before a colon', 'SMS to +447700900123: failed', 'SMS to [phone]: failed'],
    ['a phone after a label', 'phone:07700900123', 'phone:[phone]'],
    ['a percent-encoded guest link', 'next=%2Fv%2Fabc123', 'next=/v/[token]'],
  ])('redacts %s', (_, input, output) => {
    expect(redactText(input)).toBe(output);
  });

  it.each([
    'visit 550e8400-e29b-41d4-a716-446655440000 not found',
    'served on 2026-10-25 at 09:41:07',
    'at 2026-10-25 12:30:45',
    'chunk index-B91scMyG.js',
    'at app.js:1234:56',
    'ticket A-042 called to counter 3',
    'http://127.0.0.1:55321/rest/v1/rpc/join_queue',
    'at 2026-10-25T12:30:45.123Z',
  ])('leaves %j alone', (input) => {
    expect(redactText(input)).toBe(input);
  });

  it('stays fast on a long run of word characters', () => {
    const start = Date.now();
    redactText(`${'a'.repeat(80_000)} end`);
    expect(Date.now() - start).toBeLessThan(250);
  });

  it('is idempotent', () => {
    const once = redactText('+447700900123 ana@example.com /v/abc');
    expect(redactText(once)).toBe(once);
  });
});

describe('redactDeep', () => {
  it('scrubs strings at any depth and drops contact and credential keys', () => {
    const cyclic: Record<string, unknown> = { note: 'from +14155550132' };
    cyclic.self = cyclic;
    expect(
      redactDeep({
        exception: { values: [{ value: 'join failed for ana@example.com' }] },
        request: { url: 'https://q.test/v/secret-token', headers: { Authorization: 'Bearer x' } },
        extra: { guest_name: 'Ana', Phone: '+447700900123', contact_value: 'x', count: 3 },
        args: { p_token: 't', p_name: 'Ana', p_device_key: 'k', provider_refresh_token: 'r' },
        sdk: { name: 'sentry.javascript.browser', integrations: [{ name: 'Breadcrumbs' }] },
        cyclic,
      }),
    ).toEqual({
      exception: { values: [{ value: 'join failed for [email]' }] },
      request: { url: 'https://q.test/v/[token]', headers: { Authorization: '[redacted]' } },
      extra: {
        guest_name: '[redacted]',
        Phone: '[redacted]',
        contact_value: '[redacted]',
        count: 3,
      },
      args: {
        p_token: '[redacted]',
        p_name: '[redacted]',
        p_device_key: '[redacted]',
        provider_refresh_token: '[redacted]',
      },
      sdk: { name: 'sentry.javascript.browser', integrations: [{ name: 'Breadcrumbs' }] },
      cyclic: { note: 'from [phone]', self: '[cycle]' },
    });
  });

  it("drops a push subscription's endpoint and keys", () => {
    expect(
      redactDeep({ endpoint: 'https://push.example/abc', keys: { p256dh: 'BPk', auth: 'q1' } }),
    ).toEqual({ endpoint: '[redacted]', keys: { p256dh: '[redacted]', auth: '[redacted]' } });
  });
});

describe('withoutFreeText', () => {
  it("keeps an exception's type and stack and the error code, nothing else free", () => {
    const event = {
      exception: {
        values: [{ type: 'Error', value: 'boom for Zelda', stacktrace: { frames: [] } }],
      },
      logentry: { message: 'Zelda' },
      extra: { __serialized__: { details: 'Zelda' } },
      tags: { route: '/v/abc' },
    };
    expect(withoutFreeText(event, new Error('boom for Zelda'))).toEqual({
      exception: { values: [{ type: 'Error', value: '[message]', stacktrace: { frames: [] } }] },
      tags: { route: '/v/[token]' },
    });
    expect(
      withoutFreeText(event, { code: 'P0001', message: 'capacity_reached' }).exception.values[0],
    ).toMatchObject({ value: 'capacity_reached' });
  });

  it('cuts frame URLs at the query and keeps only class-like exception types', () => {
    const frame = { filename: '/v/abc?name=Zelda', abs_path: 'https://q.test/a.js#Zelda' };
    const out = withoutFreeText({
      exception: {
        values: [{ type: 'Zelda failed', value: 'x', stacktrace: { frames: [frame] } }],
      },
    });
    expect(out.exception.values[0]).toEqual({
      type: 'Error',
      value: '[message]',
      stacktrace: { frames: [{ filename: '/v/[token]', abs_path: 'https://q.test/a.js' }] },
    });
    expect(withoutFreeText({ exception: { values: [{ type: 'TypeError' }] } })).toEqual({
      exception: { values: [{ type: 'TypeError' }] },
    });
  });
});
