// HTML and text parts for queue email. The words live in the notification templates (database,
// per org and locale); this only lays them out and adds the CAN-SPAM footer to marketing mail.

export interface MarketingFooter {
  legalName?: string | null;
  postalAddress?: string | null;
  unsubscribeUrl?: string | null;
}

/** The source offer every email carries (AGPL-3.0 s13); `productName` is left out when an org hides branding. */
export interface SourceFooter {
  sourceUrl: string;
  productName?: string | null;
}

export type EmailParts =
  | { ok: true; text: string; html: string }
  | { ok: false; code: 'missing_postal_address' | 'missing_unsubscribe' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Only an https link may become an href; anything else is printed as text. */
function link(url: string, label = url): string {
  let safe = false;
  try {
    const u = new URL(url);
    safe = u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost');
  } catch {
    // not a URL: printed as text
  }
  return safe ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` : escapeHtml(label);
}

/** Paragraphs from blank-line breaks, line breaks inside; bare http(s) URLs become links. */
function htmlBody(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) =>
      p
        .split(/(https?:\/\/\S+)/)
        .map((part, i) => (i % 2 ? link(part) : escapeHtml(part)))
        .join('')
        .replace(/\n/g, '<br>'),
    )
    .map((p) => `<p>${p}</p>`)
    .join('');
}

/**
 * Lays out one message. `footer` is passed for marketing mail only: it must name a postal address
 * and an unsubscribe link, otherwise nothing is rendered and the row is dead, never sent without.
 */
export function renderEmail(input: {
  text: string;
  /** Deep link to the guest's status page. */
  url?: string;
  footer?: MarketingFooter;
  source?: SourceFooter;
}): EmailParts {
  const { footer, source } = input;
  let text = input.text;
  let foot = '';
  if (footer) {
    const address = footer.postalAddress?.trim();
    if (!address) return { ok: false, code: 'missing_postal_address' };
    if (!footer.unsubscribeUrl) return { ok: false, code: 'missing_unsubscribe' };
    const sender = [footer.legalName?.trim(), address].filter(Boolean).join('\n');
    text += `\n\n--\n${sender}`;
    if (!text.includes(footer.unsubscribeUrl)) text += `\nUnsubscribe: ${footer.unsubscribeUrl}`;
    foot =
      `<hr><p style="color:#666;font-size:12px">${escapeHtml(sender).replace(/\n/g, '<br>')}<br>` +
      `${link(footer.unsubscribeUrl, 'Unsubscribe')}</p>`;
  }
  if (source) {
    const name = source.productName?.trim();
    text += `\n\n${name ? `Powered by ${name} · ` : ''}Source code: ${source.sourceUrl}`;
    foot +=
      `<p style="color:#666;font-size:12px">${name ? `Powered by ${escapeHtml(name)} · ` : ''}` +
      `${link(source.sourceUrl, 'Source code')}</p>`;
  }
  const status = input.url ? `<p>${link(input.url)}</p>` : '';
  return {
    ok: true,
    text,
    html: `<!doctype html><html><body style="font-family:sans-serif">${htmlBody(input.text)}${status}${foot}</body></html>`,
  };
}
