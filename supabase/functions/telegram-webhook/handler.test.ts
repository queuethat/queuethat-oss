// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { createTelegramWebhookHandler, REPLIES, type TelegramJoinResult } from './handler.ts';

const SECRET = 'whsec-0123456789abcdef';

function setup(opts: { linked?: boolean; joined?: TelegramJoinResult } = {}) {
  const calls: string[] = [];
  const replies: string[] = [];
  const handler = createTelegramWebhookHandler({
    secret: SECRET,
    redeem: (code, chat) => {
      calls.push(`redeem ${code} ${chat}`);
      return Promise.resolve(opts.linked === false
        ? { linked: false, visitId: null }
        : { linked: true, visitId: 'v1' });
    },
    message: (chat, update, text) => {
      calls.push(`message ${chat} ${update} ${text}`);
      return Promise.resolve(opts.joined ?? { handled: 'unhandled' });
    },
    unlink: (chat) => {
      calls.push(`unlink ${chat}`);
      return Promise.resolve();
    },
    ticketOf: () => Promise.resolve('A012'),
    reply: (_chat, text) => {
      replies.push(text);
      return Promise.resolve();
    },
  });
  const post = (text: string, headers: Record<string, string> = { 'x-telegram-bot-api-secret-token': SECRET }, chat: object = { id: 42, type: 'private' }) =>
    handler(new Request('https://x/telegram-webhook', {
      method: 'POST',
      headers,
      body: JSON.stringify({ update_id: 7, message: { chat, text } }),
    }));
  return { post, calls, replies };
}

Deno.test('a missing or wrong secret header is 401 and touches nothing', async () => {
  const { post, calls, replies } = setup();
  assert.equal((await post('/start abcdefgh1234', {})).status, 401);
  assert.equal((await post('/start abcdefgh1234', { 'x-telegram-bot-api-secret-token': SECRET + 'x' })).status, 401);
  assert.deepEqual(calls, []);
  assert.deepEqual(replies, []);
});

Deno.test('/start with a valid code links and confirms the ticket', async () => {
  const { post, calls, replies } = setup();
  assert.equal((await post('/start abcdefgh1234')).status, 200);
  assert.deepEqual(calls, ['redeem abcdefgh1234 42']);
  assert.deepEqual(replies, [REPLIES.linked('A012')]);
});

Deno.test('a used or expired code gets a generic failure', async () => {
  const { post, replies } = setup({ linked: false });
  await post('/start abcdefgh1234');
  assert.deepEqual(replies, [REPLIES.failed]);
});

Deno.test('/stop unlinks the chat', async () => {
  const { post, calls, replies } = setup();
  await post('/stop');
  assert.deepEqual(calls, ['unlink 42']);
  assert.deepEqual(replies, [REPLIES.stopped]);
});

Deno.test('groups and other text are ignored, not errors', async () => {
  const { post, calls } = setup();
  assert.equal((await post('/start abcdefgh1234', undefined, { id: -5, type: 'group' })).status, 200);
  assert.equal((await post('hello')).status, 200);
  assert.deepEqual(calls, []);
});

Deno.test('GET is 405', async () => {
  const { post } = setup();
  const handler = createTelegramWebhookHandler({ secret: SECRET } as never);
  assert.equal((await handler(new Request('https://x/', { method: 'GET' }))).status, 405);
  void post;
});

Deno.test('/start with a location slug joins and replies with the place', async () => {
  const { post, calls, replies } = setup({ linked: false, joined: { handled: 'join', ticket: 'A012', position: 3, queue_name: 'Walk-ins' } });
  assert.equal((await post('/start demo-barber')).status, 200);
  assert.deepEqual(calls, ['redeem demo-barber 42', 'message 42 7 /start demo-barber']);
  assert.deepEqual(replies, [REPLIES.joined({ handled: 'join', ticket: 'A012', position: 3, queue_name: 'Walk-ins' })]);
});

Deno.test('a closed queue, an unknown location and several queues each get their own reply', async () => {
  for (const [handled, reply] of [['join_closed', REPLIES.closed], ['unknown', REPLIES.unknown], ['choose', REPLIES.choose]] as const) {
    const { post, replies } = setup({ linked: false, joined: { handled } });
    await post('/start demo-barber');
    assert.deepEqual(replies, [reply]);
  }
});

Deno.test('/leave goes to the join function and says what happened', async () => {
  const { post, calls, replies } = setup({ joined: { handled: 'leave' } });
  await post('/leave');
  assert.deepEqual(calls, ['message 42 7 /leave']);
  assert.deepEqual(replies, [REPLIES.left]);
});

Deno.test('an update without an id is ignored', async () => {
  const { calls } = setup();
  const handler = createTelegramWebhookHandler({ secret: SECRET, message: () => Promise.reject(new Error('no')) } as never);
  const res = await handler(new Request('https://x/', {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({ message: { chat: { id: 1, type: 'private' }, text: '/leave' } }),
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, []);
});
