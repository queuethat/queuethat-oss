// 2P-OPS12 (#218): the only place an Edge Function writes to the console (scripts/check-function-logs.sh
// fails the build on any other console call). Every line is one JSON object, redacted by the same
// rules as the web app (@qm/domain): E.164 numbers, emails, bearer tokens, 43-character tokens and
// push keys never reach the function logs (I-7, I-13).
import { redactDeep, redactText } from '@qm/domain';

/** Longest message written. Capped after redaction, so a cut never splits a value. */
const MAX_MESSAGE = 500;

type Level = 'info' | 'error';

function write(level: Level, message: string, fields?: Record<string, unknown>) {
  const entry = {
    ...(fields === undefined ? {} : redactDeep(fields)),
    level,
    msg: redactText(message).slice(0, MAX_MESSAGE),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** Logs one redacted JSON line. `fields` are redacted recursively, by key and by value. */
export function logInfo(message: string, fields?: Record<string, unknown>): void {
  write('info', message, fields);
}

/** Like `logInfo`, on stderr. */
export function logError(message: string, fields?: Record<string, unknown>): void {
  write('error', message, fields);
}
