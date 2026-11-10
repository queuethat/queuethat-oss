// Natural-language analytics (R-11) talks to a language model through this one interface. The model
// only ever receives the metric catalogue, the manager's question and (for a summary) aggregate
// numbers: callers must never put guest-level data into `system` or `user`.

/** A model call that failed. Messages never contain the API key. */
export class LlmError extends Error {
  constructor(
    readonly code: 'unavailable' | 'rejected' | 'timeout' | 'bad_response',
    message: string = code,
  ) {
    super(message);
  }
}

export interface LlmRequest {
  system: string;
  user: string;
  /** Upper bound on the reply length, in tokens. */
  maxTokens: number;
}

export interface LlmProvider {
  readonly providerName: string;
  /** Returns the model's text reply. Throws LlmError. */
  complete(request: LlmRequest): Promise<string>;
}
