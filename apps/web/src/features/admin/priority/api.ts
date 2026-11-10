import { errorCode } from '@qm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase.ts';
import { SWATCH_PRIORITY } from '../swatch.ts';

export const RULE_SOURCES = ['online', 'kiosk', 'staff', 'appointment'] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

export interface PriorityClass {
  id: string;
  name: string;
  offsetMinutes: number;
  color: string | null;
  active: boolean;
}

export interface PriorityRule {
  id: string;
  kind: 'source' | 'intake_answer';
  source: RuleSource | null;
  fieldId: string | null;
  answerValue: string | null;
  classId: string;
  rank: number;
  active: boolean;
}

/** An intake question a rule can match on, labelled with its queue. */
export interface RuleField {
  id: string;
  queueId: string;
  label: string;
  queueName: string;
}

export interface ClassSettings {
  name: string;
  offsetMinutes: number;
  color: string;
}

export const NEW_CLASS: ClassSettings = { name: '', offsetMinutes: 15, color: SWATCH_PRIORITY };

const key = (locationId: string) => ['admin', 'priority', locationId];

/** The location's priority classes and rules (Q-10) and the questions a rule can match on. */
export const priorityQuery = (locationId: string) =>
  queryOptions({
    queryKey: key(locationId),
    queryFn: async () => {
      const app = supabase.schema('app');
      const [classes, rules, fields] = await Promise.all([
        app
          .from('priority_classes')
          .select('id, name, offset_minutes, color, active')
          .eq('location_id', locationId)
          .order('sort_order')
          .order('created_at'),
        app
          .from('priority_rules')
          .select(
            'id, condition_kind, source, field_id, answer_value, priority_class_id, rank, active',
          )
          .eq('location_id', locationId)
          .order('rank')
          .order('created_at'),
        app
          .from('intake_fields')
          .select('id, queue_id, label, queues(name)')
          .eq('location_id', locationId)
          .eq('active', true)
          .order('position'),
      ]);
      for (const r of [classes, rules, fields]) if (r.error) throw r.error;
      return {
        classes: classes.data!.map((c): PriorityClass => ({
          id: c.id,
          name: c.name,
          offsetMinutes: c.offset_minutes,
          color: c.color,
          active: c.active,
        })),
        rules: rules.data!.map((r): PriorityRule => ({
          id: r.id,
          kind: r.condition_kind,
          source: r.source as RuleSource | null,
          fieldId: r.field_id,
          answerValue: r.answer_value,
          classId: r.priority_class_id,
          rank: r.rank,
          active: r.active,
        })),
        fields: fields.data!.map((f): RuleField => ({
          id: f.id,
          queueId: f.queue_id,
          label: f.label,
          queueName: f.queues?.name ?? '',
        })),
      };
    },
  });

export interface NewRule {
  classId: string;
  rank: number;
  source: RuleSource | null;
  field: RuleField | null;
  answerValue: string;
}

type Change =
  | { kind: 'createClass'; settings: ClassSettings }
  | { kind: 'updateClass'; id: string; settings: ClassSettings }
  | { kind: 'setClassActive'; id: string; active: boolean }
  | { kind: 'createRule'; rule: NewRule }
  | { kind: 'setRuleActive'; id: string; active: boolean };

/**
 * Adds, edits or switches off classes and rules under RLS (managers and up). Nothing is deleted:
 * visits keep the class they were given.
 */
export function useChangePriority(where: { orgId: string; locationId: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: Change) => {
      const app = supabase.schema('app');
      const columns = (s: ClassSettings) => ({
        name: s.name.trim(),
        offset_minutes: s.offsetMinutes,
        color: s.color,
      });
      const result =
        change.kind === 'createClass'
          ? await app
              .from('priority_classes')
              .insert({
                org_id: where.orgId,
                location_id: where.locationId,
                ...columns(change.settings),
              })
              .select('id')
          : change.kind === 'updateClass'
            ? await app
                .from('priority_classes')
                .update(columns(change.settings))
                .eq('id', change.id)
                .select('id')
            : change.kind === 'setClassActive'
              ? await app
                  .from('priority_classes')
                  .update({ active: change.active })
                  .eq('id', change.id)
                  .select('id')
              : change.kind === 'createRule'
                ? await app
                    .from('priority_rules')
                    .insert({
                      org_id: where.orgId,
                      location_id: where.locationId,
                      priority_class_id: change.rule.classId,
                      rank: change.rule.rank,
                      ...(change.rule.field
                        ? {
                            condition_kind: 'intake_answer' as const,
                            field_id: change.rule.field.id,
                            queue_id: change.rule.field.queueId,
                            answer_value: change.rule.answerValue.trim(),
                          }
                        : { condition_kind: 'source' as const, source: change.rule.source }),
                    })
                    .select('id')
                : await app
                    .from('priority_rules')
                    .update({ active: change.active })
                    .eq('id', change.id)
                    .select('id');
      if (result.error) throw new Error(errorCode(result.error));
      if (result.data.length === 0) throw new Error('permission_denied');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(where.locationId) }),
  });
}

export interface SetPriority {
  visitId: string;
  classId: string | null;
  version: number;
}

/** Sets or clears a waiting visit's class (`set_visit_priority`); the database refiles it. */
export function useSetVisitPriority() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId, classId, version }: SetPriority) => {
      const { data, error } = await supabase.rpc('set_visit_priority', {
        p_visit_id: visitId,
        // Generated types say string; null clears the class.
        p_priority_class_id: classId as string,
        p_expected_version: version,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['console', 'visits'] }),
  });
}

/** The active classes of a location, for the console's pickers. */
export const activeClassesQuery = (locationId: string) =>
  queryOptions({
    queryKey: ['console', 'priority-classes', locationId],
    queryFn: async (): Promise<PriorityClass[]> => {
      const { data, error } = await supabase
        .schema('app')
        .from('priority_classes')
        .select('id, name, offset_minutes, color, active')
        .eq('location_id', locationId)
        .eq('active', true)
        .order('sort_order')
        .order('created_at');
      if (error) throw error;
      return data.map((c) => ({
        id: c.id,
        name: c.name,
        offsetMinutes: c.offset_minutes,
        color: c.color,
        active: c.active,
      }));
    },
  });
