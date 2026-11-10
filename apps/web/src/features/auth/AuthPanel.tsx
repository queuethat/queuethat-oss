import type { ReactNode } from 'react';
import { useTranslation } from '../../lib/translation.tsx';

export type AuthPanelKind = 'ticket' | 'bento';

const light = 'flex min-w-0 flex-col justify-between gap-2 rounded-card p-6 bg-surface text-fg';

/**
 * Decorative right-hand panel of the auth screens. Static art: no data, no personal
 * information, hidden on phones. Sign-in shows one ticket, sign-up a bento of features.
 */
export function AuthPanel({ kind }: { kind: AuthPanelKind }) {
  return (
    <aside
      aria-hidden="true"
      className="hidden items-center justify-center bg-fg p-8 text-bg lg:flex lg:h-screen lg:overflow-hidden"
    >
      {kind === 'ticket' ? <Ticket /> : <Bento />}
    </aside>
  );
}

type Tone = 'light' | 'dark';
type TileSpec = { id: string; tone: Tone; visual: ReactNode };
/** One slot in a row: a single tile, or two small tiles stacked, `w` wide. */
type Cell = { w: string; tiles: TileSpec[] };

const pill = 'rounded-full bg-bg/15 px-3 py-1 text-sm';
const lightPill = 'rounded-full bg-bg px-3 py-1 text-sm text-fg';

function Tile({ spec, stacked }: { spec: TileSpec; stacked: boolean }) {
  const { t } = useTranslation('auth');
  const tr = (key: string) => t(key as never) as string;
  const tone = spec.tone === 'light' ? 'bg-surface text-fg' : 'bg-bg/10 text-bg';
  const text = (
    <div className="flex min-w-0 flex-col">
      <span className="text-lg font-bold leading-tight tracking-tight">
        {tr(`panel.bento.${spec.id}.v`)}
      </span>
      {stacked ? null : (
        <span className="text-sm opacity-70">{tr(`panel.bento.${spec.id}.body`)}</span>
      )}
    </div>
  );
  return stacked ? (
    <div
      className={`flex min-h-0 flex-1 items-center justify-between gap-3 rounded-card p-4 ${tone}`}
    >
      {text}
      <div className="shrink-0">{spec.visual}</div>
    </div>
  ) : (
    <div className={`flex min-h-0 flex-1 flex-col justify-between gap-2 rounded-card p-5 ${tone}`}>
      <span className="text-xs font-bold uppercase tracking-wide opacity-70">
        {tr(`panel.bento.${spec.id}.k`)}
      </span>
      <div className="flex min-h-12 flex-1 items-center">{spec.visual}</div>
      {text}
    </div>
  );
}

function Bento() {
  const { t } = useTranslation('auth');
  const str = (key: string) => t(key as never) as string;
  const sample: Record<string, string> = {};
  for (const id of ['alerts', 'domains', 'console', 'payments', 'history', 'announce', 'api']) {
    sample[id] = str(`panel.bento.${id}.sample`);
  }
  const big = (text: string, size = 'text-4xl') => (
    <span className={`${size} font-bold tracking-tight`}>{text}</span>
  );
  const list = (key: string, cls: string) =>
    (t(key as never, { returnObjects: true }) as unknown as string[]).map((label) => (
      <span key={label} className={cls}>
        {label}
      </span>
    ));
  const teamPills = list('panel.bento.team.pills', lightPill);
  const templatePills = list('panel.bento.templates.pills', pill);
  const languagePills = list('panel.bento.languages.pills', lightPill);
  const qr = (size: string) => (
    <span
      className={`${size} rounded-control border-4 border-fg`}
      style={{
        background:
          'repeating-conic-gradient(currentColor 0 25%, transparent 0 50%) 0 0 / 0.75rem 0.75rem',
      }}
    />
  );
  const spec = (id: string, tone: Tone, visual: ReactNode): TileSpec => ({ id, tone, visual });
  const rows: { h: string; seconds: number; reverse: boolean; cells: Cell[] }[] = [
    {
      h: 'h-64',
      seconds: 70,
      reverse: false,
      cells: [
        { w: 'w-80', tiles: [spec('join', 'light', qr('size-20'))] },
        {
          w: 'w-64',
          tiles: [
            spec('wait', 'dark', big(str('panel.bento.wait.sample'), 'text-xl')),
            spec(
              'alerts',
              'light',
              <span className="rounded-card bg-bg px-2 py-1 text-xs">{sample.alerts}</span>,
            ),
          ],
        },
        {
          w: 'w-96',
          tiles: [spec('display', 'dark', big(str('panel.bento.display.sample'), 'text-6xl'))],
        },
        {
          w: 'w-64',
          tiles: [
            spec('kiosk', 'light', big(str('panel.bento.kiosk.sample'), 'text-xl')),
            spec('domains', 'dark', <span className={`${pill} text-xs`}>{sample.domains}</span>),
          ],
        },
      ],
    },
    {
      h: 'h-44',
      seconds: 80,
      reverse: true,
      cells: [
        {
          w: 'w-64',
          tiles: [
            spec(
              'console',
              'dark',
              <span className="rounded-control bg-bg px-4 py-2 font-semibold text-fg">
                {sample.console}
              </span>,
            ),
          ],
        },
        {
          w: 'w-80',
          tiles: [
            spec(
              'reports',
              'light',
              <span className="flex h-12 w-full items-end gap-1.5">
                {[40, 65, 50, 85, 100].map((h) => (
                  <b key={h} className="flex-1 rounded-sm bg-fg" style={{ height: `${h}%` }} />
                ))}
              </span>,
            ),
          ],
        },
        {
          w: 'w-56',
          tiles: [
            spec(
              'payments',
              'dark',
              <span className="rounded-full bg-success-soft px-3 py-1 text-sm font-bold text-success-strong">
                {sample.payments}
              </span>,
            ),
          ],
        },
        {
          w: 'w-72',
          tiles: [spec('team', 'light', <span className="flex gap-2">{teamPills}</span>)],
        },
        {
          w: 'w-64',
          tiles: [spec('history', 'dark', <span className={pill}>{sample.history}</span>)],
        },
        {
          w: 'w-72',
          tiles: [
            spec(
              'announce',
              'light',
              <span className="w-full rounded-control bg-warning-soft px-3 py-2 text-sm font-medium text-warning-strong">
                {sample.announce}
              </span>,
            ),
          ],
        },
      ],
    },
    {
      h: 'h-56',
      seconds: 75,
      reverse: false,
      cells: [
        {
          w: 'w-72',
          tiles: [
            spec(
              'hours',
              'light',
              <span className="flex gap-1">
                {[1, 1, 1, 1, 1, 0, 0].map((on, i) => (
                  <b
                    key={i}
                    className={`size-4 rounded-full ${on ? 'bg-fg' : 'border border-fg'}`}
                  />
                ))}
              </span>,
            ),
            spec('languages', 'dark', <span className="flex gap-1">{languagePills}</span>),
          ],
        },
        {
          w: 'w-80',
          tiles: [
            spec(
              'templates',
              'dark',
              <span className="flex flex-wrap gap-1.5">{templatePills}</span>,
            ),
          ],
        },
        {
          w: 'w-64',
          tiles: [
            spec(
              'api',
              'light',
              <span className="rounded-full bg-bg px-3 py-1 font-mono text-sm">{sample.api}</span>,
            ),
          ],
        },
      ],
    },
  ];
  return (
    <div className="flex w-full flex-col gap-3">
      {rows.map((row, r) => (
        <div key={r} className={`auth-fade overflow-hidden ${row.h}`}>
          <div
            className={`auth-row flex h-full w-max ${row.reverse ? 'reverse' : ''}`}
            style={{ ['--row-seconds' as string]: `${row.seconds}s` }}
          >
            {[0, 1].flatMap((copy) =>
              row.cells.map((cell, i) => (
                <div
                  key={`${copy}-${i}`}
                  className={`flex h-full shrink-0 flex-col gap-3 pr-3 ${cell.w}`}
                >
                  {cell.tiles.map((tile) => (
                    <Tile key={tile.id} spec={tile} stacked={cell.tiles.length > 1} />
                  ))}
                </div>
              )),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Ticket() {
  const { t } = useTranslation('auth');
  return (
    <div className="flex w-full max-w-xs flex-col items-center gap-6 text-center">
      <div className={`${light} w-full gap-3 p-6 text-left`}>
        <span className="self-start rounded-full bg-warning-soft px-3 py-1 text-xs font-bold uppercase tracking-wide text-warning-strong">
          {t('panel.ticket.badge')}
        </span>
        <span className="text-6xl font-bold tracking-tight">{t('panel.ticket.number')}</span>
        <span className="text-muted">{t('panel.ticket.eta')}</span>
      </div>
      <div>
        <p className="text-xl font-semibold">{t('panel.ticket.title')}</p>
        <p className="opacity-80">{t('panel.ticket.body')}</p>
      </div>
    </div>
  );
}
