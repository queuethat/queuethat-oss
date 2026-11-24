// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import { Badge, Button, Card, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '@app/lib/translation.tsx';
import { useCurrentOrg } from '@app/features/auth/current.ts';
import {
  EDITABLE_CHANNELS,
  EDITABLE_TRIGGERS,
  templatesQuery,
  type EditableChannel,
  type EditableTrigger,
} from '@app/features/admin/templates/api.ts';
import { TemplateEditor } from './TemplatesPage.tsx';

/** Slot `queue.templates`: one queue's own wording, over the organization's defaults (Q-15, #238). */
export default function QueueTemplates({
  queueId,
  readOnly,
}: {
  queueId: string;
  readOnly: boolean;
}) {
  const { t } = useTranslation('admin-templates');
  const org = useCurrentOrg();
  const templates = useQuery({ ...templatesQuery(org?.id ?? '', queueId), enabled: !!org });
  const [editing, setEditing] = useState<{ trigger: EditableTrigger; medium: EditableChannel }>();
  if (!org || !templates.data) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{t('queue.messages')}</h2>
      <p className="text-muted">{t('queue.messagesIntro')}</p>
      <ul className="flex flex-col gap-2">
        {EDITABLE_TRIGGERS.flatMap((trigger) =>
          EDITABLE_CHANNELS.map((channel) => {
            const rows = templates.data.filter(
              (r) => r.trigger === trigger && r.medium === channel,
            );
            const own = rows.find((r) => r.queueId === queueId);
            const base =
              rows.find((r) => r.orgId !== null && r.queueId === null) ??
              rows.find((r) => r.orgId === null);
            const isEditing = editing?.trigger === trigger && editing.medium === channel;
            const name = `${t(`trigger.${trigger}`)} · ${t(`channel.${channel}`)}`;
            return (
              <li key={`${trigger}-${channel}`} className="rounded-card border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{name}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone={own ? 'info' : 'neutral'}>
                      {t(own ? 'queue.overridden' : 'queue.usesDefault')}
                    </Badge>
                    <Button
                      variant="secondary"
                      aria-label={t(readOnly ? 'viewLabel' : 'editLabel', {
                        trigger: t(`trigger.${trigger}`),
                        channel: t(`channel.${channel}`),
                      })}
                      aria-expanded={isEditing}
                      onClick={() =>
                        setEditing(isEditing ? undefined : { trigger, medium: channel })
                      }
                    >
                      {t(readOnly ? 'view' : 'edit')}
                    </Button>
                  </span>
                </div>
                {isEditing ? (
                  <TemplateEditor
                    key={`${trigger}-${channel}-${own?.version ?? 0}`}
                    orgId={org.id}
                    queueId={queueId}
                    trigger={trigger}
                    medium={channel}
                    custom={own}
                    system={base}
                    readOnly={readOnly}
                    onDone={() => setEditing(undefined)}
                  />
                ) : null}
              </li>
            );
          }),
        )}
      </ul>
    </Card>
  );
}
