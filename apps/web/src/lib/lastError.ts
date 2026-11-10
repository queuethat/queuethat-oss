const ID = /^[A-Za-z0-9_-]{1,64}$/;
let lastId: string | undefined;

/** Remembers the id of the newest error report this tab sent, for support requests. */
export function rememberErrorId(id: unknown): void {
  if (typeof id === 'string' && ID.test(id)) lastId = id;
}

/** The id of the newest error report this tab sent, or undefined if none was sent. */
export function lastErrorId(): string | undefined {
  return lastId;
}
