import { describe, expect, it } from 'vitest';
import { parseRichText } from './richText.ts';

describe('parseRichText', () => {
  it('splits paragraphs on blank lines and keeps single line breaks', () => {
    const b = parseRichText('One\nstill one\n\nTwo');
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ kind: 'p' });
    expect((b[0] as { runs: unknown[] }).runs).toHaveLength(2);
  });

  it('reads "- " lines as one bullet list and **x** as bold', () => {
    const [intro, list] = parseRichText('Please:\n- **Never** run\n- Walk');
    expect(intro!.kind).toBe('p');
    expect(list).toEqual({
      kind: 'ul',
      items: [
        [
          { text: 'Never', bold: true },
          { text: ' run', bold: false },
        ],
        [{ text: 'Walk', bold: false }],
      ],
    });
  });

  it('treats markup as plain text', () => {
    const [p] = parseRichText('a <b>x</b> **');
    expect(JSON.stringify(p)).toContain('<b>');
    expect(JSON.stringify(p)).not.toContain('"bold":true');
  });
});
