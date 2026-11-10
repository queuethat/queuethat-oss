import { describe, expect, it } from 'vitest';
import { renderEmail } from './layout.ts';

describe('renderEmail', () => {
  it('lays text out as escaped paragraphs and links the status page', () => {
    const r = renderEmail({ text: 'Hi <img src=x>\n\nTurn A1 & go', url: 'https://q.test/v/abc' });
    expect(r).toMatchObject({ ok: true, text: 'Hi <img src=x>\n\nTurn A1 & go' });
    expect(r.ok && r.html).toContain('<p>Hi &#60;img src=x&#62;</p><p>Turn A1 &#38; go</p>');
    expect(r.ok && r.html).toContain('<a href="https://q.test/v/abc">');
  });

  it('adds sender and unsubscribe link to marketing mail, once', () => {
    const r = renderEmail({
      text: 'Sale\n\nStop: https://q.test/u?n=1',
      footer: {
        legalName: 'Acme',
        postalAddress: '1 Main St',
        unsubscribeUrl: 'https://q.test/u?n=1',
      },
    });
    expect(r.ok && r.text).toBe('Sale\n\nStop: https://q.test/u?n=1\n\n--\nAcme\n1 Main St');
  });

  it('refuses marketing mail with no postal address or no unsubscribe link', () => {
    expect(
      renderEmail({ text: 'x', footer: { postalAddress: ' ', unsubscribeUrl: 'https://u' } }),
    ).toEqual({
      ok: false,
      code: 'missing_postal_address',
    });
    expect(renderEmail({ text: 'x', footer: { postalAddress: '1 Main St' } })).toEqual({
      ok: false,
      code: 'missing_unsubscribe',
    });
  });

  it('adds the source link, with the product name unless the org hides it', () => {
    const source = { sourceUrl: 'https://src.test/repo', productName: 'QueueThat' };
    const shown = renderEmail({ text: 'Hi', source });
    expect(shown.ok && shown.text).toBe(
      'Hi\n\nPowered by QueueThat · Source code: https://src.test/repo',
    );
    expect(shown.ok && shown.html).toContain(
      'Powered by QueueThat · <a href="https://src.test/repo">Source code</a>',
    );
    const hidden = renderEmail({
      text: 'Hi',
      source: { sourceUrl: source.sourceUrl, productName: null },
    });
    expect(hidden.ok && hidden.text).toBe('Hi\n\nSource code: https://src.test/repo');
    expect(hidden.ok && hidden.html).not.toContain('QueueThat');
    expect(hidden.ok && hidden.html).toContain('<a href="https://src.test/repo">Source code</a>');
  });

  it('never turns a non-http URL into a link', () => {
    const r = renderEmail({ text: 'x', url: 'javascript:alert(1)' });
    expect(r.ok && r.html).not.toContain('href="javascript');
  });
});
