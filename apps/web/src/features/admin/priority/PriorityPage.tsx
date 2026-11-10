import { Badge, Button, Card, EmptyState, Input, PageHeader, Select, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { SWATCH_PRIORITY } from '../swatch.ts';
import { canManageQueues } from '../queues/api.ts';
import {
  NEW_CLASS,
  priorityQuery,
  RULE_SOURCES,
  useChangePriority,
  type ClassSettings,
  type PriorityClass,
  type RuleField,
  type RuleSource,
} from './api.ts';

const KNOWN_ERRORS = ['permission_denied', 'invalid_input'];

/** The location's priority classes and the rules that apply them at join (Q-10). */
export function PriorityPage() {
  const { t } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const role = useCurrentOrg()?.role;
  const query = useQuery({ ...priorityQuery(location?.id ?? ''), enabled: !!location });
  const change = useChangePriority({
    orgId: location?.org_id ?? '',
    locationId: location?.id ?? '',
  });
  // 'new-class', a class id, 'new-rule' or null: which form is open.
  const [editing, setEditing] = useState<string | null>(null);
  if (!location || !query.data) return <Skeleton label={t('priority.loading')} rows={2} />;
  const { classes, rules, fields } = query.data;
  const canManage = canManageQueues(role);
  const failure = change.error
    ? `errors.${KNOWN_ERRORS.includes(change.error.message) ? change.error.message : 'unknown'}`
    : null;
  const open = (id: string | null) => {
    change.reset();
    setEditing(id);
  };
  const close = { onSuccess: () => setEditing(null) };
  const className = (id: string) => classes.find((c) => c.id === id)?.name ?? '';
  const activeClasses = classes.filter((c) => c.active);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-8">
      <Link
        to="/admin/queues"
        className="inline-flex min-h-target items-center font-medium text-primary underline"
      >
        {t('services.back')}
      </Link>
      <PageHeader title={t('priority.title')} description={t('priority.intro')} />
      {canManage ? null : <p className="text-muted">{t('queues.readOnly')}</p>}
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure as 'errors.unknown') : null}
      </p>

      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">{t('priority.classes')}</h2>
        {canManage && editing !== 'new-class' ? (
          <Button onClick={() => open('new-class')}>{t('priority.addClass')}</Button>
        ) : null}
      </div>
      {editing === 'new-class' ? (
        <ClassForm
          heading={t('priority.newClass')}
          initial={NEW_CLASS}
          pending={change.isPending}
          onCancel={() => open(null)}
          onSave={(settings) => change.mutate({ kind: 'createClass', settings }, close)}
        />
      ) : null}
      {classes.length === 0 && editing !== 'new-class' ? (
        <EmptyState title={t('priority.empty')} description={t('priority.emptyHint')} />
      ) : null}
      <ul className="flex flex-col gap-3">
        {classes.map((c) => (
          <li key={c.id}>
            {editing === c.id ? (
              <ClassForm
                heading={t('priority.editClass', { name: c.name })}
                initial={{
                  name: c.name,
                  offsetMinutes: c.offsetMinutes,
                  color: c.color ?? SWATCH_PRIORITY,
                }}
                pending={change.isPending}
                onCancel={() => open(null)}
                onSave={(settings) =>
                  change.mutate({ kind: 'updateClass', id: c.id, settings }, close)
                }
              />
            ) : (
              <Card
                className="flex flex-wrap items-center justify-between gap-3"
                data-testid="priority-class"
              >
                <div>
                  <h3 className="text-lg font-semibold">{c.name}</h3>
                  <p className="text-sm text-muted">
                    {t('priority.offset', { count: c.offsetMinutes })}
                  </p>
                  {c.active ? null : <Badge tone="neutral">{t('priority.off')}</Badge>}
                </div>
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => open(c.id)}>
                      {t('priority.edit')}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={change.isPending}
                      onClick={() =>
                        change.mutate({ kind: 'setClassActive', id: c.id, active: !c.active })
                      }
                    >
                      {c.active ? t('priority.switchOff') : t('priority.switchOn')}
                    </Button>
                  </div>
                ) : null}
              </Card>
            )}
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted">{t('priority.dragNote')}</p>

      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">{t('priority.rules')}</h2>
        {canManage && editing !== 'new-rule' && activeClasses.length > 0 ? (
          <Button onClick={() => open('new-rule')}>{t('priority.addRule')}</Button>
        ) : null}
      </div>
      <p className="text-muted">{t('priority.rulesIntro')}</p>
      {editing === 'new-rule' ? (
        <RuleForm
          classes={activeClasses}
          fields={fields}
          nextRank={Math.max(0, ...rules.map((r) => r.rank)) + 1}
          pending={change.isPending}
          onCancel={() => open(null)}
          onSave={(rule) => change.mutate({ kind: 'createRule', rule }, close)}
        />
      ) : null}
      <ul className="flex flex-col gap-3">
        {rules.map((r) => (
          <li key={r.id}>
            <Card
              className="flex flex-wrap items-center justify-between gap-3"
              data-testid="priority-rule"
            >
              <div>
                <p className="font-medium">
                  {r.kind === 'source'
                    ? t('priority.ruleSource', {
                        source: t(`priority.sources.${r.source ?? 'online'}`),
                        class: className(r.classId),
                      })
                    : t('priority.ruleAnswer', {
                        question: fields.find((f) => f.id === r.fieldId)?.label ?? '',
                        answer: r.answerValue,
                        class: className(r.classId),
                      })}
                </p>
                <p className="text-sm text-muted">{t('priority.rank', { rank: r.rank })}</p>
                {r.active ? null : <Badge tone="neutral">{t('priority.off')}</Badge>}
              </div>
              {canManage ? (
                <Button
                  variant="secondary"
                  disabled={change.isPending}
                  onClick={() =>
                    change.mutate({ kind: 'setRuleActive', id: r.id, active: !r.active })
                  }
                >
                  {r.active ? t('priority.switchOff') : t('priority.switchOn')}
                </Button>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClassForm({
  heading,
  initial,
  pending,
  onCancel,
  onSave,
}: {
  heading: string;
  initial: ClassSettings;
  pending: boolean;
  onCancel: () => void;
  onSave: (settings: ClassSettings) => void;
}) {
  const { t } = useTranslation('admin');
  const [s, setS] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(s);
  };
  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <h3 className="text-lg font-semibold">{heading}</h3>
        <Input
          label={t('priority.name')}
          required
          maxLength={60}
          pattern=".*\S.*"
          value={s.name}
          onChange={(e) => setS((v) => ({ ...v, name: e.target.value }))}
        />
        <Input
          label={t('priority.offsetLabel')}
          hint={t('priority.offsetHint')}
          type="number"
          inputMode="numeric"
          min={0}
          max={720}
          required
          value={String(s.offsetMinutes)}
          onChange={(e) =>
            setS((v) => ({ ...v, offsetMinutes: Number.parseInt(e.target.value, 10) || 0 }))
          }
        />
        <Input
          label={t('priority.color')}
          hint={t('priority.colorHint')}
          type="color"
          value={s.color}
          onChange={(e) => setS((v) => ({ ...v, color: e.target.value }))}
        />
        <div className="flex justify-between gap-4">
          <Button variant="secondary" onClick={onCancel}>
            {t('priority.cancel')}
          </Button>
          <Button type="submit" loading={pending}>
            {t('priority.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function RuleForm({
  classes,
  fields,
  nextRank,
  pending,
  onCancel,
  onSave,
}: {
  classes: PriorityClass[];
  fields: RuleField[];
  nextRank: number;
  pending: boolean;
  onCancel: () => void;
  onSave: (rule: {
    classId: string;
    rank: number;
    source: RuleSource | null;
    field: RuleField | null;
    answerValue: string;
  }) => void;
}) {
  const { t } = useTranslation('admin');
  const [kind, setKind] = useState<'source' | 'intake_answer'>('source');
  const [source, setSource] = useState<RuleSource>('appointment');
  const [fieldId, setFieldId] = useState(fields[0]?.id ?? '');
  const [answer, setAnswer] = useState('');
  const [classId, setClassId] = useState(classes[0]?.id ?? '');
  const [rank, setRank] = useState(String(nextRank));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      classId,
      rank: Number.parseInt(rank, 10) || nextRank,
      source: kind === 'source' ? source : null,
      field: kind === 'intake_answer' ? (fields.find((f) => f.id === fieldId) ?? null) : null,
      answerValue: answer,
    });
  };
  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <h3 className="text-lg font-semibold">{t('priority.newRule')}</h3>
        <Select
          label={t('priority.condition')}
          value={kind}
          onChange={(e) => setKind(e.target.value as 'source' | 'intake_answer')}
        >
          <option value="source">{t('priority.conditionSource')}</option>
          {fields.length > 0 ? (
            <option value="intake_answer">{t('priority.conditionAnswer')}</option>
          ) : null}
        </Select>
        {kind === 'source' ? (
          <Select
            label={t('priority.sourceLabel')}
            value={source}
            onChange={(e) => setSource(e.target.value as RuleSource)}
          >
            {RULE_SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(`priority.sources.${s}`)}
              </option>
            ))}
          </Select>
        ) : (
          <>
            <Select
              label={t('priority.question')}
              value={fieldId}
              onChange={(e) => setFieldId(e.target.value)}
            >
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {`${f.queueName} · ${f.label}`}
                </option>
              ))}
            </Select>
            <Input
              label={t('priority.answer')}
              hint={t('priority.answerHint')}
              required
              maxLength={200}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
          </>
        )}
        <Select
          label={t('priority.giveClass')}
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
        >
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Input
          label={t('priority.rankLabel')}
          hint={t('priority.rankHint')}
          type="number"
          inputMode="numeric"
          min={0}
          value={rank}
          onChange={(e) => setRank(e.target.value)}
        />
        <div className="flex justify-between gap-4">
          <Button variant="secondary" onClick={onCancel}>
            {t('priority.cancel')}
          </Button>
          <Button type="submit" loading={pending}>
            {t('priority.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
