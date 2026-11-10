// 2B-I9 (#314): the verification snippets in docs/integrations are tested against a payload signed
// by the sender's own signWebhook, so the guides cannot drift from the real signature scheme.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { signWebhook } from '../../packages/domain/src/webhook-signature';
// @ts-expect-error plain ES module shipped as a docs example, no types
import { verifyWebhook as verifyNode } from '../../docs/integrations/examples/verify-webhook.mjs';

const secret = 'whsec_0123456789abcdef0123456789abcdef0123456789abcdef';
const now = 1_700_000_000;
const body = JSON.stringify({ id: 'v:42', type: 'visit.called', api_version: 'v1', data: { visit: { id: 'x' } } });
const tampered = body.replace('v:42', 'v:43');

function verifyPython(rawBody: string, header: string): boolean {
  const out = execFileSync(
    'python3',
    ['docs/integrations/examples/verify_webhook.py', secret, rawBody, header, String(now)],
    { encoding: 'utf8' },
  );
  return out.trim() === 'true';
}

describe('webhook verification examples', () => {
  it('AC1: the Node example verifies a signed payload and rejects a tampered one', async () => {
    const header = await signWebhook(secret, body, now);
    expect(verifyNode(secret, body, header, 300, now)).toBe(true);
    expect(verifyNode(secret, tampered, header, 300, now)).toBe(false);
    expect(verifyNode(secret, body, header, 300, now + 301)).toBe(false);
  });

  it('the Node example accepts either secret during a rotation', async () => {
    const header = await signWebhook(['whsec_new', secret], body, now);
    expect(verifyNode(secret, body, header, 300, now)).toBe(true);
  });

  it('the Python example agrees', async () => {
    const header = await signWebhook(secret, body, now);
    expect(verifyPython(body, header)).toBe(true);
    expect(verifyPython(tampered, header)).toBe(false);
  });

  it('the n8n workflow is valid JSON and wires trigger, verification and an api_v1 call', () => {
    const wf = JSON.parse(readFileSync('docs/integrations/n8n/queue-events.workflow.json', 'utf8'));
    const types = wf.nodes.map((n: { type: string }) => n.type);
    expect(types).toEqual(
      expect.arrayContaining(['n8n-nodes-base.webhook', 'n8n-nodes-base.code', 'n8n-nodes-base.if', 'n8n-nodes-base.httpRequest']),
    );
    const code = wf.nodes.find((n: { type: string }) => n.type === 'n8n-nodes-base.code').parameters.jsCode as string;
    expect(code).toContain('x-qm-signature');
    const http = wf.nodes.find((n: { type: string }) => n.type === 'n8n-nodes-base.httpRequest');
    expect(JSON.stringify(http)).toContain('Content-Profile');
    expect(JSON.stringify(http)).toContain('X-API-Key');
  });
});
