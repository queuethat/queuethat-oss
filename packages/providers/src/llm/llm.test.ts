import { describe, expect, it } from 'vitest';
import { AnthropicLlmProvider } from './anthropic.ts';
import { LlmError } from './contract.ts';
import { FakeLlmProvider } from './fake.ts';

const request = { system: 'sys', user: 'question', maxTokens: 100 };
const reply = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('AnthropicLlmProvider', () => {
  it('sends the key as a header and the prompt as a single user message', async () => {
    let seen: { headers: Record<string, string>; body: Record<string, unknown> } | undefined;
    const fetcher = (async (_url: string, init: RequestInit) => {
      seen = {
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body as string),
      };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hello' }] }));
    }) as unknown as typeof fetch;
    const p = new AnthropicLlmProvider({ apiKey: 'sk-test', model: 'm', fetch: fetcher });
    await expect(p.complete(request)).resolves.toBe('hello');
    expect(seen!.headers['x-api-key']).toBe('sk-test');
    expect(seen!.body).toMatchObject({
      model: 'm',
      max_tokens: 100,
      system: 'sys',
      messages: [{ role: 'user', content: 'question' }],
    });
  });

  it.each([
    [401, 'rejected'],
    [500, 'unavailable'],
  ])('maps HTTP %i to %s without leaking the key', async (status, code) => {
    const p = new AnthropicLlmProvider({
      apiKey: 'sk-secret',
      model: 'm',
      fetch: reply(status, {}),
    });
    const error = await p.complete(request).catch((e) => e as LlmError);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe(code);
    expect((error as LlmError).message).not.toContain('sk-secret');
  });

  it('treats a reply without text as bad_response', async () => {
    const p = new AnthropicLlmProvider({
      apiKey: 'k',
      model: 'm',
      fetch: reply(200, { content: [] }),
    });
    await expect(p.complete(request)).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('FakeLlmProvider', () => {
  it('replays scripted replies, repeats the last and records requests', async () => {
    const f = new FakeLlmProvider(['a', new LlmError('timeout')]);
    await expect(f.complete(request)).resolves.toBe('a');
    await expect(f.complete(request)).rejects.toMatchObject({ code: 'timeout' });
    await expect(f.complete(request)).rejects.toMatchObject({ code: 'timeout' });
    expect(f.requests).toHaveLength(3);
  });
});
