// Sends one HTTP/1.1 POST to a vetted IP address while still validating TLS against the real host name.
// fetch() always resolves the host itself, so a hostile DNS server could answer a public IP for the
// handler's check and an internal one for the request (DNS rebinding). Connecting to the address the
// handler already vetted removes that second lookup. Redirects are never followed (only the status line
// is read), and nothing of the answer is kept.

const MAX_HEAD_BYTES = 8192;

/** POSTs `body` to `url` over a connection to `address`. Throws on timeout, TLS failure or a bad answer. */
export async function postPinned(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  address: string,
): Promise<{ status: number }> {
  const u = new URL(url);
  const tls = u.protocol === 'https:';
  const port = u.port ? Number(u.port) : tls ? 443 : 80;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const payload = new TextEncoder().encode(body);
  const lines = [`POST ${u.pathname || '/'}${u.search} HTTP/1.1`, `Host: ${u.host}`];
  for (const [k, v] of Object.entries({ ...headers, 'Content-Length': String(payload.length), Connection: 'close' })) {
    if (/[\r\n]/.test(k + v)) throw new Error('bad_header');
    lines.push(`${k}: ${v}`);
  }
  const head = new TextEncoder().encode(lines.join('\r\n') + '\r\n\r\n');

  let conn: Deno.Conn | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { conn?.close(); } catch { /* already closed */ }
  }, timeoutMs);
  try {
    conn = await Deno.connect({ hostname: address, port });
    if (timedOut) conn.close();
    // startTls checks the certificate against the host name (and sends it as SNI), not the IP.
    if (tls) conn = await Deno.startTls(conn as Deno.TcpConn, { hostname: host });
    await writeAll(conn, head);
    await writeAll(conn, payload);
    const buf = new Uint8Array(MAX_HEAD_BYTES);
    let len = 0;
    let end = -1;
    while (end < 0 && len < buf.length) {
      const n = await conn.read(buf.subarray(len));
      if (n === null) break;
      len += n;
      end = new TextDecoder().decode(buf.subarray(0, len)).indexOf('\r\n');
    }
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(new TextDecoder().decode(buf.subarray(0, len)));
    if (!status) throw new Error(timedOut ? 'timeout' : 'bad_response');
    return { status: Number(status[1]) };
  } finally {
    clearTimeout(timer);
    try { conn?.close(); } catch { /* already closed */ }
  }
}

async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let sent = 0;
  while (sent < data.length) sent += await conn.write(data.subarray(sent));
}
