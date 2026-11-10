/** One block of an agreement's text. Bold runs are `{bold}`; nothing here is ever HTML. */
export type RichRun = { text: string; bold: boolean };
export type RichBlock = { kind: 'p'; runs: RichRun[][] } | { kind: 'ul'; items: RichRun[][] };

function runs(line: string): RichRun[] {
  return line
    .split(/(\*\*[^*]+\*\*)/)
    .filter((part) => part !== '')
    .map((part) =>
      part.startsWith('**') && part.endsWith('**') && part.length > 4
        ? { text: part.slice(2, -2), bold: true }
        : { text: part, bold: false },
    );
}

/**
 * The agreement `body` as paragraphs and bullet lists: a blank line starts a paragraph, a line
 * starting `- ` is a bullet, `**x**` is bold. The database refuses `<` and `>` in the text, and
 * the result is rendered as React text nodes, so no markup in it can ever run.
 */
export function parseRichText(body: string): RichBlock[] {
  return body
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .flatMap((block): RichBlock[] => {
      const out: RichBlock[] = [];
      for (const line of block.split('\n')) {
        const bullet = line.startsWith('- ');
        const last = out[out.length - 1];
        if (bullet) {
          const item = runs(line.slice(2));
          if (last?.kind === 'ul') last.items.push(item);
          else out.push({ kind: 'ul', items: [item] });
        } else if (last?.kind === 'p') last.runs.push(runs(line));
        else out.push({ kind: 'p', runs: [runs(line)] });
      }
      return out;
    });
}
