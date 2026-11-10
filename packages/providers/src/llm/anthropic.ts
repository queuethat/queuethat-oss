import { LlmError, type LlmProvider, type LlmRequest } from './contract.ts';

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_TIMEOUT_MS = 20_000;

export interface AnthropicOptions {
  /** The org's own key (BYO), read from Vault for one invocation. */
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Anthropic Messages API behind the LlmProvider interface. */
export class AnthropicLlmProvider implements LlmProvider {
  readonly providerName = 'anthropic';
  constructor(private readonly options: AnthropicOptions) {}

  async complete(request: LlmRequest): Promise<string> {
    const doFetch = this.options.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? ANTHROPIC_TIMEOUT_MS),
      });
    } catch (e) {
      throw new LlmError((e as Error).name === 'TimeoutError' ? 'timeout' : 'unavailable');
    }
    if (res.status === 401 || res.status === 403 || res.status === 400)
      throw new LlmError('rejected');
    if (!res.ok) throw new LlmError('unavailable');
    const body = (await res.json().catch(() => null)) as {
      content?: { type: string; text?: string }[];
    } | null;
    const text = body?.content?.find((c) => c.type === 'text')?.text;
    if (typeof text !== 'string') throw new LlmError('bad_response');
    return text;
  }
}
