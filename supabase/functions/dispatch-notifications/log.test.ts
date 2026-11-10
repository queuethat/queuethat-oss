// 2P-OPS12 (#218): the shared logger's redaction. Run with `pnpm test:functions`.
// (_shared has no deno.json, so the dispatcher, which imports the same file, runs it.)
import assert from 'node:assert/strict';
import { logError, logInfo } from '../_shared/log.ts';

const TOKEN = 'A'.repeat(43);

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const { log, error } = console;
  console.log = (line: string) => void lines.push(line);
  console.error = (line: string) => void lines.push(line);
  try {
    fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines;
}

Deno.test('AC1: a phone, an email and a 43-character token never appear in the output', () => {
  const [line] = capture(() => logInfo(`called +14155550123 jane@example.com token=${TOKEN}`));
  for (const secret of ['+14155550123', 'jane@example.com', TOKEN]) {
    assert.ok(!line!.includes(secret), `${secret} leaked: ${line}`);
  }
  assert.equal(JSON.parse(line!).level, 'info');
});

Deno.test('fields are redacted recursively, by key and by value', () => {
  const [line] = capture(() =>
    logError('push failed', {
      to: { email: 'jane@example.com', note: 'call +14155550123' },
      subscription: { endpoint: 'https://push.example/x', p256dh: 'k', auth: 'a' },
      list: [`Bearer ${TOKEN}`],
      status: 410,
    }),
  );
  for (const secret of ['jane@example.com', '+14155550123', TOKEN, 'push.example', '"p256dh":"k"']) {
    assert.ok(!line!.includes(secret), `${secret} leaked: ${line}`);
  }
  const entry = JSON.parse(line!);
  assert.equal(entry.level, 'error');
  assert.equal(entry.status, 410);
});
