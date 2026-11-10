import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

export interface HeaderRule {
  pattern: string;
  headers: Record<string, string>;
  /** Headers an earlier matching rule set that this rule removes (`! Name` lines). */
  detach: string[];
}

/**
 * Parses a Cloudflare Pages `_headers` file: an unindented URL pattern, then indented
 * `Name: value` lines and `! Name` detach lines. Supports the subset this repo uses
 * (`*` splats, `:name` segments).
 */
export function parseHeadersFile(source: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const raw of source.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      rules.push({ pattern: line, headers: {}, detach: [] });
      continue;
    }
    const rule = rules.at(-1);
    const detach = /^\s+!\s*([\w-]+)$/.exec(line);
    if (rule && detach) {
      rule.detach.push(detach[1]!);
      continue;
    }
    const colon = line.indexOf(':');
    if (!rule || colon === -1) throw new Error(`Unexpected line in _headers: ${line}`);
    rule.headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return rules;
}

function patternToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

/**
 * The headers Cloudflare Pages sends for `path`: every matching rule applies in order, a rule's
 * `!` lines first remove what earlier rules set, and a header set by more than one rule is
 * joined with ", ".
 */
export function headersForPath(rules: HeaderRule[], path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rule of rules) {
    if (!patternToRegExp(rule.pattern).test(path)) continue;
    for (const name of rule.detach) delete result[name];
    for (const [name, value] of Object.entries(rule.headers)) {
      result[name] = result[name] ? `${result[name]}, ${value}` : value;
    }
  }
  return result;
}

/**
 * Makes `vite preview` send the headers from `public/_headers`, so what we test locally is
 * what Cloudflare Pages serves. Not applied to the dev server, whose HMR client needs
 * inline scripts and a websocket to itself.
 */
export function staticHeaders(file: URL): Plugin {
  return {
    name: 'qm-static-headers',
    configurePreviewServer(server) {
      const rules = parseHeadersFile(readFileSync(file, 'utf8'));
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        for (const [name, value] of Object.entries(headersForPath(rules, path))) {
          res.setHeader(name, value);
        }
        next();
      });
    },
  };
}
