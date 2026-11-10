import type { LlmProvider, LlmRequest } from './contract.ts';

/**
 * Scripted LlmProvider for tests and the local stack: replies come from `replies` in order (the
 * last one repeats) and every request is kept so tests can assert what the model was sent.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly providerName = 'fake';
  readonly requests: LlmRequest[] = [];
  constructor(private readonly replies: (string | Error)[]) {}

  async complete(request: LlmRequest): Promise<string> {
    this.requests.push(request);
    const reply = this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    return reply;
  }
}
