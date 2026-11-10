import * as sdk from '@sentry/browser';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { lastErrorId } from './lastError.ts';
import { sentryOptions, startErrorReporting } from './sentry.ts';

// The real SDK with a transport that keeps the envelopes instead of sending them, so the test
// sees exactly the bytes that would reach Sentry.
const sent: string[] = [];
const decoder = new TextDecoder();
sdk.init({
  ...sentryOptions(sdk, 'https://public@o1.ingest.sentry.io/1'),
  transport: (options) =>
    sdk.createTransport(options, async (request) => {
      sent.push(typeof request.body === 'string' ? request.body : decoder.decode(request.body));
      return { statusCode: 200 };
    }),
});

afterAll(() => sdk.close());

async function report(error: Error): Promise<string> {
  sent.length = 0;
  sdk.captureException(error);
  await sdk.flush(2000);
  return sent.join('\n');
}

describe('error reports', () => {
  // #1138: a support request can name the newest error this tab reported.
  it('remember the id of the newest report for support requests', async () => {
    const id = sdk.captureException(new Error('boom'));
    await sdk.flush(2000);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(lastErrorId()).toBe(id);
  });

  // #530: a bare name can't be recognised, so no free text is sent at all.
  it('send no message text, so a name, phone or email in it never leaves', async () => {
    const body = await report(new Error('boom for Zelda +447700900123 zelda@example.com'));
    for (const secret of ['Zelda', 'zelda', '7700900123', 'example.com', 'boom']) {
      expect(body).not.toContain(secret);
    }
    expect(body).toContain('"type":"Error","value":"[message]"');
    // The stack and the SDK's own metadata survive, or the report is useless.
    expect(body).toContain('"stacktrace"');
    expect(body).toContain('"public_key":"public"');
    expect(body).toContain('"name":"sentry.javascript.browser"');
  });

  it("keep the database's error code, and drop a thrown object's fields", async () => {
    sent.length = 0;
    sdk.captureException({ code: 'P0001', message: 'rate_limited', details: 'Zelda' });
    await sdk.flush(2000);
    let body = sent.join('\n');
    expect(body).toContain('"value":"rate_limited"');
    expect(body).not.toContain('Zelda');

    body = await report(new Error('queue_not_accepting'));
    expect(body).toContain('"value":"queue_not_accepting"');
  });

  it('keep only the kind, method, status and path of breadcrumbs', async () => {
    window.history.pushState({}, '', '/v/the-guest-secret-token?name=Zelda');
    sdk.addBreadcrumb({
      category: 'fetch',
      data: { method: 'GET', url: '/rest/v1/x?name=eq.Zelda', status_code: 200, body: 'Zelda' },
    });
    sdk.addBreadcrumb({ category: 'ui', message: 'Called Zelda' });
    console.info('joined as Zelda');
    const body = await report(new Error('boom'));
    expect(body).toContain('"url":"/rest/v1/x"');
    expect(body).toContain('/v/[token]');
    expect(body).not.toContain('the-guest-secret-token');
    expect(body).not.toContain('Zelda');
  });

  it("ask Sentry not to infer the sender's IP address", async () => {
    const body = await report(new Error('boom'));
    expect(body).toContain('"infer_ip":"never"');
    expect(body).not.toContain('"infer_ip":"auto"');
  });
});

describe('startErrorReporting', () => {
  it('does nothing without a DSN', () => {
    const listen = vi.spyOn(window, 'addEventListener');
    startErrorReporting('');
    expect(listen).not.toHaveBeenCalled();
  });
});
