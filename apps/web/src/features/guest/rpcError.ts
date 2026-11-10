/**
 * Thrown for any non-2xx answer. `message` carries the database error code for errorCode(), or
 * `rate_limited` for the gateway's 429.
 */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly details: string | null,
    readonly status: number,
  ) {
    super(message);
  }
}
