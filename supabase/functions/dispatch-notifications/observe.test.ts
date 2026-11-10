// O6 (#77): the Edge Functions' observer. Run with `pnpm test:functions`.
// (_shared has no deno.json, so the dispatcher, which imports the same file, runs it.)
import assert from 'node:assert/strict';
import { createObserver, type ErrorSink } from '../_shared/observe.ts';

function fakeSink() {
  const sent: unknown[] = [];
  let flushed = 0;
  const sink: ErrorSink = {
    captureMessage: (m) => void sent.push(m),
    captureException: (e) => void sent.push(e),
    flush: () => Promise.resolve(Boolean(++flushed)),
  };
  return { sent, flushes: () => flushed, load: () => Promise.resolve(sink) };
}

function captureConsole(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const { log, error } = console;
  // Lines are JSON (_shared/log.ts); these tests assert the message.
  console.log = (line: string) => void lines.push(JSON.parse(line).msg);
  console.error = (line: string) => void lines.push(JSON.parse(line).msg);
  return fn()
    .then(() => lines)
    .finally(() => {
      console.log = log;
      console.error = error;
    });
}

Deno.test('logs and reports are redacted before they leave the function', async () => {
  const fake = fakeSink();
  const observe = createObserver('dispatch', 'https://k@o1.ingest.sentry.io/1', fake.load);
  const lines = await captureConsole(async () => {
    observe.log('outbox 1 sms sent to +447700900123');
    observe.error('send failed for ana@example.com via /v/guest-token');
    await observe.serve(() => Promise.resolve(new Response('ok')))(new Request('http://x/'));
  });
  assert.deepEqual(lines, [
    'outbox 1 sms sent to [phone]',
    'send failed for [email] via /v/[token]',
  ]);
  assert.deepEqual(fake.sent, ['dispatch: send failed for [email] via /v/[token]']);
  assert.equal(fake.flushes(), 1, 'reports are flushed before the response returns');
});

// #530: a provider error can echo a rendered message, guest name included, which no pattern
// recognises. The cause goes to the function log only; Sentry gets the caller's fixed line.
Deno.test('the cause of an error is logged but never reported', async () => {
  const fake = fakeSink();
  const observe = createObserver('dispatch', 'https://k@o1.ingest.sentry.io/1', fake.load);
  const lines = await captureConsole(async () => {
    observe.error('outbox 7 sms error', new Error('rejected "Zelda, you are next" to +447700900123'));
    await observe.serve(() => Promise.resolve(new Response('ok')))(new Request('http://x/'));
  });
  assert.deepEqual(lines, ['outbox 7 sms error: Error: rejected "Zelda, you are next" to [phone]']);
  assert.deepEqual(fake.sent, ['dispatch: outbox 7 sms error']);
});

Deno.test('a plain-object cause is logged as JSON, redacted', async () => {
  const observe = createObserver('dispatch', undefined);
  const lines = await captureConsole(async () => {
    observe.error('outbox 8 email error', { code: 422, to: 'ana@example.com' });
  });
  assert.deepEqual(lines, ['outbox 8 email error: {"code":422,"to":"[email]"}']);
});

Deno.test('an uncaught throw is reported and answered with a bare 500', async () => {
  const fake = fakeSink();
  const observe = createObserver('pair-device', 'https://k@o1.ingest.sentry.io/1', fake.load);
  const boom = new Error('db down');
  let response: Response | undefined;
  await captureConsole(async () => {
    response = await observe.serve(() => Promise.reject(boom))(new Request('http://x/'));
  });
  assert.equal(response?.status, 500);
  assert.deepEqual(await response?.json(), { error: 'unknown' });
  assert.deepEqual(fake.sent, [boom]);
});

Deno.test('without a DSN nothing is loaded or reported', async () => {
  let loaded = false;
  const observe = createObserver('unsubscribe', undefined, () => {
    loaded = true;
    return Promise.reject(new Error('should not load'));
  });
  await captureConsole(async () => {
    observe.error('unsubscribe failed');
    await observe.serve(() => Promise.resolve(new Response('ok')))(new Request('http://x/'));
  });
  assert.equal(loaded, false);
});

Deno.test('a Sentry SDK that fails to load never fails a request', async () => {
  const observe = createObserver('dispatch', 'https://k@o1.ingest.sentry.io/1', () =>
    Promise.reject(new Error('no network')));
  let response: Response | undefined;
  await captureConsole(async () => {
    observe.error('send failed');
    response = await observe.serve(() => Promise.resolve(new Response('ok')))(new Request('http://x/'));
  });
  assert.equal(response?.status, 200);
});

Deno.test('lines are redacted before they are capped, so a cut never leaks part of a value', async () => {
  const observe = createObserver('dispatch', undefined);
  const lines = await captureConsole(async () => {
    observe.log(`${'word '.repeat(96)}zelda.quokka@example.com`);
  });
  assert.equal(lines[0], `${'word '.repeat(96)}[email]`);
  assert.ok(!lines[0]!.includes('zelda'));
});
