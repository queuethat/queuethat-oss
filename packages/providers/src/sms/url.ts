/** https, or plain http to the local machine for dev fakes. Parsed, so `http://localhost@evil.test` is refused. */
export function isSecureUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    );
  } catch {
    return false;
  }
}
