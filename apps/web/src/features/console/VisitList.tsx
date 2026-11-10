import { formatLocalTime } from '@qm/domain';
import {
  Badge,
  Button,
  Card,
  ConfirmDestructive,
  Dialog,
  EmptyState,
  Icon,
  Input,
  LinkButton,
  iconRefresh,
} from '@qm/ui';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useNow } from '../../lib/now.ts';
import { ScreenEmpty } from '../../components/ScreenEmpty.tsx';
import { ShareLine } from './ShareLine.tsx';
import { HistoryDrawer } from './history/HistoryDrawer.tsx';
import { TransferDialog, type OnTransfer } from './transfer/TransferDialog.tsx';
import {
  AssignDialog,
  assigneeLabel,
  type AssignTargets,
  type OnAssign,
} from './assign/AssignDialog.tsx';
import { PriorityDialog, type OnPriority } from './priority/PriorityDialog.tsx';
import type { PriorityClass } from '../admin/priority/api.ts';
import { DeliveryWarning, TextBadge } from './messages/Messages.tsx';
import type { TextState } from './messages/api.ts';
import { ChatBadge } from './chat/Unread.tsx';
import { RowTags, VisitDetail, type OnSaveNotes } from './detail/VisitDetail.tsx';
import { TagChips } from '../crm/tags/GuestTags.tsx';
import { RemoveAndBlock } from './RemoveAndBlock.tsx';
import { afterIdForMove } from './reorder/position.ts';
import { SortableRow, SortableWaiting } from './reorder/SortableWaiting.tsx';
import {
  ACTIVE_STATES,
  type ActiveState,
  type BlockDuration,
  type ConsoleQueue,
  type ConsoleVisit,
  type GuestBadge,
  type VisitAction,
} from './api.ts';

/** The row actions this console offers, in button order; a row shows those it allows. */
const PRIMARY_ACTIONS = [
  'check_in',
  'call',
  'recall',
  'start',
  'complete',
  'requeue',
  'reinstate',
] as const satisfies readonly VisitAction[];
/** Destructive actions sit apart from the primary ones and always confirm first (S-19). */
const DESTRUCTIVE_ACTIONS = ['no_show', 'remove'] as const satisfies readonly VisitAction[];

/** The order a visit usually moves through the day: the first allowed one is the row's main action. */
const MAIN_ORDER = [
  'check_in',
  'call',
  'start',
  'complete',
  'reinstate',
  'requeue',
  'recall',
] as const satisfies readonly VisitAction[];

/** The one action a row draws as primary; none when "send on" to the next queue takes that place. */
export function mainAction(
  actions: readonly VisitAction[],
  journeyStep = false,
): VisitAction | null {
  if (journeyStep) return null;
  return MAIN_ORDER.find((a) => actions.includes(a)) ?? null;
}

/** Runs an action; a returned promise keeps a confirm dialog busy until it settles. */
export type OnVisitAction = (
  visit: ConsoleVisit,
  action: VisitAction,
  reason?: string,
) => void | Promise<unknown>;

/** Puts a waiting visit just after `afterId` (null = first); resolves when the call settles. */
export type OnVisitMove = (visit: ConsoleVisit, afterId: string | null) => void | Promise<unknown>;

/** Minutes since `iso`, never negative (a tablet's clock can run behind the server's). */
export function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
}

interface Section {
  key: ActiveState | 'later';
  state: ActiveState;
  later: boolean;
}

/** The list's sections: expected guests split into appointments and those who joined for later. */
const SECTIONS = ACTIVE_STATES.flatMap((state): Section[] =>
  state === 'expected'
    ? [
        { key: 'expected', state, later: false },
        { key: 'later', state, later: true },
      ]
    : [{ key: state, state, later: false }],
);

/**
 * One queue's waiting, called and serving sections (C2, #59), in the order the database keeps.
 * Each row offers the actions its `allowed_actions` include (C3, #60); `busy` is the visit whose
 * action is in flight.
 */
export function VisitList({
  visits,
  onAction,
  onMove,
  onSaveNotes,
  onTransfer,
  onAdvance,
  queues = [],
  onAssign,
  assignTargets,
  onPriority,
  priorityClasses,
  timeZone,
  busy,
  badges,
  guestTags,
  onBlock,
  selectedId,
  pendingIds,
  deliveryWarnings,
  textStates,
}: {
  /** Visits whose latest `called` message failed to reach the guest (N-12). */
  deliveryWarnings?: Set<string>;
  /** Whether each guest can receive texts (3-CG10), by visit id. */
  textStates?: Map<string, TextState>;
  /** Visits with an offline action waiting to replay (S-12). */
  pendingIds?: Set<string | null>;
  /** The row the keyboard shortcuts act on (S-10). */
  selectedId?: string | null;
  visits: ConsoleVisit[];
  /** The location's zone, for appointment times. */
  timeZone?: string;
  onAction?: OnVisitAction;
  /** Makes the waiting section reorderable (#135): drag, or the row's move buttons. */
  onMove?: OnVisitMove;
  /** Enables the details sheet (notes and tags) on every row. */
  onSaveNotes?: OnSaveNotes;
  /** Enables Transfer on waiting rows (S-5); `queues` are the targets. */
  onTransfer?: OnTransfer;
  /** Q-12: sends a serving guest to the next step of their journey. */
  onAdvance?: (visit: ConsoleVisit) => void | Promise<unknown>;
  queues?: ConsoleQueue[];
  /** Enables Assign on waiting rows and the "For ..." badge (Q-18). */
  onAssign?: OnAssign;
  assignTargets?: AssignTargets;
  /** Enables Priority on waiting rows and the class badge (Q-10). */
  onPriority?: OnPriority;
  priorityClasses?: PriorityClass[];
  busy?: string | null;
  /** Repeat guests by visit id (2P-CRM4); absent or empty shows no badges. */
  badges?: Map<string, GuestBadge>;
  /** Guest tag names by guest id (2B-C2); absent shows no chips. */
  guestTags?: Map<string, string[]>;
  /** Managers only (2P-PRV6): remove the visit and block who joined. */
  onBlock?: (visit: ConsoleVisit, reason: string, days: BlockDuration) => Promise<unknown>;
}) {
  const { t } = useTranslation('staff');
  const now = useNow(30_000);
  const groups = groupTickets(visits);
  const suggestions = tagSuggestions(visits);
  const groupWith = (v: ConsoleVisit) =>
    v.groupKey ? (groups.get(v.groupKey)?.filter((x) => x !== v.ticket) ?? []) : [];
  return (
    <div className="flex flex-col gap-4">
      {SECTIONS.map(({ key, state, later }) => {
        const rows = visits.filter(
          (v) => v.status === state && (state !== 'expected' || (v.arriveAfter !== null) === later),
        );
        // Guests who joined for later get a section of their own, shown only while there are some.
        if (later && rows.length === 0) return null;
        return (
          <section key={key} aria-labelledby={`section-${key}`} data-testid={`section-${key}`}>
            <h2 id={`section-${key}`} className="mb-2 text-lg font-semibold">
              {t(`console.section.${key}`, { count: rows.length })}
            </h2>
            {rows.length === 0 ? (
              state === 'waiting' && visits.length === 0 ? (
                <ScreenEmpty kind="console" action={<ShareLine />} />
              ) : (
                <p className="text-muted">{t(`console.empty.${key}`)}</p>
              )
            ) : (
              <>
                {state === 'waiting' && onMove ? (
                  <SortableWaiting
                    ids={rows.map((v) => v.id)}
                    labelOf={(id) => rows.find((v) => v.id === id)?.ticket ?? ''}
                    onMove={(id, toIndex) => {
                      const target = afterIdForMove(
                        rows.map((v) => v.id),
                        id,
                        toIndex,
                      );
                      const visit = rows.find((v) => v.id === id);
                      if (target && visit) void onMove(visit, target.afterId);
                    }}
                  >
                    {rows.map((v, index) => (
                      <SortableRow
                        key={v.id}
                        id={v.id}
                        gripLabel={t('console.reorder.grip', { ticket: v.ticket })}
                        gripText={t('console.reorder.gripGlyph')}
                      >
                        {(sort) => (
                          <Row
                            visit={v}
                            selected={selectedId === v.id}
                            pending={pendingIds?.has(v.id) ?? false}
                            state={state}
                            now={now}
                            onAction={onAction}
                            busy={busy === v.id}
                            badge={badges?.get(v.id)}
                            deliveryWarning={deliveryWarnings?.has(v.id)}
                            textState={textStates?.get(v.id)}
                            tags={v.guestId ? guestTags?.get(v.guestId) : undefined}
                            suggestions={suggestions}
                            onSaveNotes={onSaveNotes}
                            onTransfer={onTransfer}
                            onAdvance={onAdvance}
                            onAssign={onAssign}
                            assignTargets={assignTargets}
                            onPriority={onPriority}
                            priorityClasses={priorityClasses}
                            queues={queues}
                            timeZone={timeZone}
                            onBlock={onBlock}
                            groupWith={groupWith(v)}
                            sort={sort}
                            move={{
                              index,
                              total: rows.length,
                              to: (toIndex) => {
                                const target = afterIdForMove(
                                  rows.map((r) => r.id),
                                  v.id,
                                  toIndex,
                                );
                                if (target) void onMove(v, target.afterId);
                              },
                            }}
                          />
                        )}
                      </SortableRow>
                    ))}
                  </SortableWaiting>
                ) : (
                  <ol className="flex flex-col gap-2">
                    {rows.map((v) => (
                      <li key={v.id} data-testid="visit">
                        <Row
                          visit={v}
                          selected={selectedId === v.id}
                          pending={pendingIds?.has(v.id) ?? false}
                          state={state}
                          now={now}
                          onAction={onAction}
                          busy={busy === v.id}
                          badge={badges?.get(v.id)}
                          deliveryWarning={deliveryWarnings?.has(v.id)}
                          textState={textStates?.get(v.id)}
                          tags={v.guestId ? guestTags?.get(v.guestId) : undefined}
                          suggestions={suggestions}
                          onSaveNotes={onSaveNotes}
                          onTransfer={onTransfer}
                          onAdvance={onAdvance}
                          onAssign={onAssign}
                          assignTargets={assignTargets}
                          onPriority={onPriority}
                          priorityClasses={priorityClasses}
                          queues={queues}
                          timeZone={timeZone}
                          onBlock={onBlock}
                          groupWith={groupWith(v)}
                        />
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Row({
  visit,
  selected = false,
  pending = false,
  state,
  now,
  onAction,
  busy,
  badge,
  deliveryWarning = false,
  textState,
  tags,
  suggestions = [],
  onSaveNotes,
  onTransfer,
  onAdvance,
  queues = [],
  onAssign,
  assignTargets,
  onPriority,
  priorityClasses,
  timeZone,
  onBlock,
  groupWith = [],
  sort,
  move,
}: {
  selected?: boolean;
  pending?: boolean;
  deliveryWarning?: boolean;
  timeZone?: string;
  /** Set on reorderable rows: the drag binding, and the button alternatives to dragging. */
  sort?: { grip: ReactNode; dragging: boolean };
  move?: { index: number; total: number; to: (index: number) => void };
  /** Tickets of the other visits that joined together with this one. */
  groupWith?: string[];
  visit: ConsoleVisit;
  state: ActiveState;
  now: number;
  onAction?: OnVisitAction;
  busy: boolean;
  badge?: GuestBadge;
  textState?: TextState;
  tags?: string[];
  suggestions?: string[];
  onSaveNotes?: OnSaveNotes;
  onTransfer?: OnTransfer;
  /** Q-12: sends a serving guest to the next step of their journey. */
  onAdvance?: (visit: ConsoleVisit) => void | Promise<unknown>;
  queues?: ConsoleQueue[];
  onAssign?: OnAssign;
  assignTargets?: AssignTargets;
  /** Enables Priority on waiting rows and the class badge (Q-10). */
  onPriority?: OnPriority;
  priorityClasses?: PriorityClass[];
  onBlock?: (visit: ConsoleVisit, reason: string, days: BlockDuration) => Promise<unknown>;
}) {
  const { t } = useTranslation('staff');
  const [detailOpen, setDetailOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const priorityClass = priorityClasses?.find((c) => c.id === visit.priorityClassId);
  const assignee = assignTargets
    ? assigneeLabel(visit, assignTargets, t('console.assign.someone'))
    : null;
  const allowed = <A extends VisitAction>(list: readonly A[]): A[] =>
    onAction ? list.filter((a) => visit.actions.includes(a)) : [];
  const primary = allowed(PRIMARY_ACTIONS);
  const destructive = allowed(DESTRUCTIVE_ACTIONS);
  const journeyStep = Boolean(
    onAdvance &&
    visit.status === 'serving' &&
    visit.journeyNextQueueId &&
    visit.actions.includes('complete'),
  );
  const main = mainAction(primary, journeyStep);
  const minutes = minutesSince(visit.since, now);
  const { i18n } = useTranslation('staff');
  const arrival = state === 'expected' ? arrivalState(visit, now) : null;
  return (
    <Card
      aria-current={selected ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      className={`flex flex-wrap items-center gap-4${sort?.dragging ? ' opacity-70 shadow-lg' : ''}${selected ? ' ring-4 ring-primary' : ''}`}
    >
      {sort && move ? (
        <div className="flex shrink-0 gap-1">
          {sort.grip}
          <Button
            variant="secondary"
            className="px-3"
            disabled={move.index === 0}
            aria-label={t('console.reorder.top', { ticket: visit.ticket })}
            onClick={() => move.to(0)}
          >
            {t('console.reorder.topGlyph')}
          </Button>
          <Button
            variant="secondary"
            className="px-3"
            disabled={move.index === 0}
            aria-label={t('console.reorder.up', { ticket: visit.ticket })}
            onClick={() => move.to(move.index - 1)}
          >
            {t('console.reorder.upGlyph')}
          </Button>
          <Button
            variant="secondary"
            className="px-3"
            disabled={move.index === move.total - 1}
            aria-label={t('console.reorder.down', { ticket: visit.ticket })}
            onClick={() => move.to(move.index + 1)}
          >
            {t('console.reorder.downGlyph')}
          </Button>
        </div>
      ) : null}
      <span className="w-20 shrink-0 text-2xl font-bold tabular-nums">{visit.ticket}</span>
      {pending ? <Badge tone="warning">{t('console.offline.pending')}</Badge> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-lg font-medium">
          {visit.name ?? t('console.noName')}
          {visit.partySize > 1 ? ` · ${t('console.party', { count: visit.partySize })}` : ''}
        </span>
        {groupWith.length > 0 ? (
          <Badge tone="info" data-testid="group-badge">
            {t('console.group', { tickets: groupWith.join(', ') })}
          </Badge>
        ) : null}
        {visit.source === 'appointment' && state !== 'expected' ? (
          <Badge tone="info" data-testid="appointment-badge">
            {t('console.appointment.badge')}
          </Badge>
        ) : null}
        {arrival ? (
          <Badge tone={arrival === 'late' ? 'warning' : 'info'} data-testid="arrival-badge">
            {t(`console.arrival.${arrival}`)}
          </Badge>
        ) : null}
        {visit.onTheWay ? (
          <Badge tone="success" data-testid="on-the-way-badge">
            {t('console.onTheWay')}
          </Badge>
        ) : null}
        {priorityClass ? (
          <Badge tone="info" data-testid="priority-badge">
            {t('console.priority.badge', { name: priorityClass.name })}
          </Badge>
        ) : null}
        {deliveryWarning ? <DeliveryWarning /> : null}
        <TextBadge state={textState} />
        {badge ? <ReturningBadge visit={visit} badge={badge} /> : null}
        <TagChips names={tags} />
        <RowTags visit={visit} />
        <ChatBadge visitId={visit.id} />
        {assignee ? (
          <Badge tone="info" data-testid="assignee-badge">
            {t('console.assign.badge', { who: assignee })}
          </Badge>
        ) : null}
        <span className="truncate text-muted">
          {[visit.service, state !== 'waiting' && visit.counter].filter(Boolean).join(' · ')}
        </span>
      </div>
      <span className="shrink-0 text-muted tabular-nums">
        {state === 'expected'
          ? t('console.expectedAt', {
              time: formatLocalTime(new Date(visit.since), timeZone ?? 'UTC', i18n.language),
            })
          : minutes === 0
            ? t(`console.since.${state}Now`)
            : t(`console.since.${state}`, { count: minutes })}
      </span>
      {primary.length > 0 ? (
        <div className="flex gap-2">
          {primary.map((action) => (
            <Button
              key={action}
              variant={action === main ? 'primary' : 'secondary'}
              aria-label={t(`console.actionLabel.${action}`, { ticket: visit.ticket })}
              loading={busy}
              onClick={() => void onAction?.(visit, action)}
            >
              {t(`console.action.${action}`)}
            </Button>
          ))}
        </div>
      ) : null}
      {onAdvance && journeyStep ? (
        <Button
          loading={busy}
          aria-label={t('console.journey.sendLabel', {
            ticket: visit.ticket,
            queue: queues.find((q) => q.id === visit.journeyNextQueueId)?.name ?? '',
          })}
          onClick={() => void onAdvance(visit)}
        >
          {t('console.journey.send', {
            queue: queues.find((q) => q.id === visit.journeyNextQueueId)?.name ?? '',
          })}
        </Button>
      ) : null}
      {onSaveNotes ? (
        <>
          <Button
            variant="quiet"
            aria-label={t('console.detail.open', { ticket: visit.ticket })}
            onClick={() => setDetailOpen(true)}
          >
            {t('console.detail.openLabel')}
          </Button>
          {detailOpen ? (
            <VisitDetail
              visit={visit}
              suggestions={suggestions}
              open
              onClose={() => setDetailOpen(false)}
              onSave={onSaveNotes}
            />
          ) : null}
        </>
      ) : null}
      {timeZone ? (
        <>
          <Button
            variant="quiet"
            aria-label={t('console.history.openFor', { ticket: visit.ticket })}
            onClick={() => setHistoryOpen(true)}
          >
            {t('console.history.open')}
          </Button>
          {historyOpen ? (
            <HistoryDrawer
              visitId={visit.id}
              ticket={visit.ticket}
              timeZone={timeZone}
              onClose={() => setHistoryOpen(false)}
            />
          ) : null}
        </>
      ) : null}
      {onPriority && priorityClasses && priorityClasses.length > 0 && visit.status === 'waiting' ? (
        <>
          <Button
            variant="quiet"
            aria-label={t('console.priority.openFor', { ticket: visit.ticket })}
            onClick={() => setPriorityOpen(true)}
          >
            {t('console.priority.open')}
          </Button>
          {priorityOpen ? (
            <PriorityDialog
              visit={visit}
              classes={priorityClasses}
              onPriority={onPriority}
              onClose={() => setPriorityOpen(false)}
            />
          ) : null}
        </>
      ) : null}
      {onAssign && assignTargets && visit.status === 'waiting' ? (
        <>
          <Button
            variant="quiet"
            aria-label={t('console.assign.openFor', { ticket: visit.ticket })}
            onClick={() => setAssignOpen(true)}
          >
            {t('console.assign.open')}
          </Button>
          {assignOpen ? (
            <AssignDialog
              visit={visit}
              targets={assignTargets}
              onAssign={onAssign}
              onClose={() => setAssignOpen(false)}
            />
          ) : null}
        </>
      ) : null}
      {onTransfer && visit.status === 'waiting' ? (
        <>
          <Button
            variant="quiet"
            aria-label={t('console.transfer.openFor', { ticket: visit.ticket })}
            onClick={() => setTransferOpen(true)}
          >
            {t('console.transfer.open')}
          </Button>
          {transferOpen ? (
            <TransferDialog
              visit={visit}
              queues={queues}
              onTransfer={onTransfer}
              onClose={() => setTransferOpen(false)}
            />
          ) : null}
        </>
      ) : null}
      {destructive.length > 0 && onAction ? (
        <div className="flex gap-2 border-l border-border pl-4">
          {destructive.map((action) => (
            <Destructive key={action} visit={visit} action={action} onAction={onAction} />
          ))}
          {onBlock && visit.actions.includes('remove') ? (
            <RemoveAndBlock visit={visit} onBlock={onBlock} />
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * "Returning (n visits)" with an icon, so it never relies on colour. A tap opens a short summary
 * and a way to the full profile (2P-CRM4, #187).
 */
function ReturningBadge({ visit, badge }: { visit: ConsoleVisit; badge: GuestBadge }) {
  const guestId = visit.guestId;
  const { t, i18n } = useTranslation('staff');
  const [open, setOpen] = useState(false);
  const label = t('console.returning.badge', { count: badge.visitCount });
  return (
    <>
      <Button
        variant="secondary"
        className="self-start"
        data-testid="returning-badge"
        aria-label={t('console.returning.open', { ticket: visit.ticket, label })}
        onClick={() => setOpen(true)}
      >
        <Icon icon={iconRefresh} size="sm" className="mr-1 inline" />
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('console.returning.title', { ticket: visit.ticket })}
        description={t('console.returning.body', {
          count: badge.visitCount,
          last: badge.lastVisitAt
            ? new Date(badge.lastVisitAt).toLocaleDateString(i18n.language)
            : '',
        })}
      >
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {t('console.returning.close')}
          </Button>
          {guestId ? (
            <LinkButton
              render={(p) => <Link to="/admin/guests/$guestId" params={{ guestId }} {...p} />}
            >
              {t('console.returning.profile')}
            </LinkButton>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}

/** Early, on time or late, by comparing the database's thresholds to the clock. */
export function arrivalState(visit: ConsoleVisit, now: number): 'early' | 'onTime' | 'late' | null {
  if (!visit.earlyUntil || !visit.lateAfter) return null;
  if (now < Date.parse(visit.earlyUntil)) return 'early';
  return now > Date.parse(visit.lateAfter) ? 'late' : 'onTime';
}

/** Tags on today's visits, most used first: what staff are likely to reach for again. */
function tagSuggestions(visits: ConsoleVisit[]): string[] {
  const counts = new Map<string, number>();
  for (const v of visits) for (const tag of v.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
}

/** Group key → the tickets that share it, for the group badge (2A-J15B). */
function groupTickets(visits: ConsoleVisit[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const v of visits) {
    if (v.groupKey) groups.set(v.groupKey, [...(groups.get(v.groupKey) ?? []), v.ticket]);
  }
  return groups;
}

/** Loading failed and polling hasn't recovered yet. */
export function VisitListError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('staff');
  return (
    <EmptyState
      title={t('console.error.title')}
      description={t('console.error.body')}
      action={<Button onClick={onRetry}>{t('console.error.retry')}</Button>}
    />
  );
}

function Destructive({
  visit,
  action,
  onAction,
}: {
  visit: ConsoleVisit;
  action: (typeof DESTRUCTIVE_ACTIONS)[number];
  onAction: OnVisitAction;
}) {
  const { t } = useTranslation('staff');
  const [reason, setReason] = useState('');
  const needsReason = action === 'remove';
  return (
    <ConfirmDestructive
      triggerLabel={t(`console.action.${action}`)}
      triggerAriaLabel={t(`console.actionLabel.${action}`, { ticket: visit.ticket })}
      triggerVariant="secondary"
      title={t(`console.confirm.${action}.title`, { ticket: visit.ticket })}
      description={t(`console.confirm.${action}.body`)}
      confirmLabel={t(`console.confirm.${action}.confirm`)}
      cancelLabel={t('console.confirm.cancel')}
      confirmDisabled={needsReason && reason.trim() === ''}
      onConfirm={() => onAction(visit, action, needsReason ? reason.trim() : undefined)}
    >
      {needsReason ? (
        <Input
          label={t('console.confirm.remove.reason')}
          hint={t('console.confirm.remove.reasonHint')}
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
        />
      ) : null}
    </ConfirmDestructive>
  );
}
