// Keeps `ee/` (QueueThat Commercial License) separate from the AGPL core. Two rules:
//
// 1. Every code file under `ee/` starts with an SPDX header naming LicenseRef-QueueThat-EE, so a
//    copy of one file still says which licence applies to it.
// 2. No file outside `ee/` imports from `ee/`. A build opts in through the extension points
//    (QT_WEB_EXTENSIONS=ee/web/extensions.ts); without it the build holds no `ee/` code.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const HEADER = 'SPDX-License-Identifier: LicenseRef-QueueThat-EE';
const CODE = /\.(?:[cm]?[jt]sx?|sql|sh)$/;
const IMPORT = /(?:from|import|require\(|import\()\s*['"]([^'"]+)['"]/g;
const SKIP_HEADER = ['ee/LICENSE', 'ee/README.md'];
// Its test spells out import lines as fixtures.
const SELF_TEST = 'scripts/check-ee-boundary.test.mjs';

const inEe = (path) => path.startsWith('ee/');

/** Code files under ee/ whose first 5 lines do not carry the SPDX header. */
export function missingHeader(files) {
  return Object.entries(files)
    .filter(([path]) => inEe(path) && CODE.test(path) && !SKIP_HEADER.includes(path))
    .filter(([, text]) => !text.split('\n').slice(0, 5).join('\n').includes(HEADER))
    .map(([path]) => `${path}: first lines must contain "${HEADER}"`);
}

/** True when `spec`, imported from `file`, resolves into ee/. */
function pointsIntoEe(file, spec) {
  if (/^(?:\.\.?\/)/.test(spec)) {
    const parts = file.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    return parts.join('/').startsWith('ee/');
  }
  return /^ee\//.test(spec);
}

/** Imports in files outside ee/ that point into ee/. */
export function coreImportsEe(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    if (inEe(path) || path === SELF_TEST || !CODE.test(path)) continue;
    for (const [, spec] of text.matchAll(IMPORT)) {
      if (pointsIntoEe(path, spec)) errors.push(`${path}: imports ${spec} from ee/`);
    }
  }
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const listed = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((p) => p && CODE.test(p));
  const files = Object.fromEntries(listed.map((p) => [p, readFileSync(p, 'utf8')]));
  const errors = [...missingHeader(files), ...coreImportsEe(files)];
  if (errors.length > 0) {
    console.error(`check-ee-boundary:\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  console.log('check-ee-boundary passed');
}
