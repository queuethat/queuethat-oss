import { Button, Input, Textarea } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import type { FormRow } from './api.ts';
import { FormBuilder } from './builder/FormBuilder.tsx';
import type { BuilderField } from './builder/fields.ts';
import { Preview } from './builder/preview/Preview.tsx';

export interface EditorSave {
  name: string;
  purposeText: string;
  retentionDays: number;
  fields: BuilderField[];
  publish: boolean;
}

export interface EditorProps {
  /** Null while creating. */
  form: FormRow | null;
  healthTagged: boolean;
  pending: boolean;
  onCancel: () => void;
  onSave: (save: EditorSave) => void;
}

/**
 * The editor: name, purpose, retention, the drag-and-drop question builder (B2) and a live phone preview (B3), saved as a draft
 * or published for every target at once. Editing never changes what guests see until publish.
 */
export function FormEditor({ form, healthTagged, pending, onCancel, onSave }: EditorProps) {
  const { t } = useTranslation('admin-forms');
  const [name, setName] = useState(form?.name ?? '');
  const [purposeText, setPurposeText] = useState(form?.purposeText ?? '');
  const [retention, setRetention] = useState(String(form?.retentionDays ?? 365));
  const [fields, setFields] = useState<BuilderField[]>(form?.fields ?? []);
  const days = Number(retention);
  const valid = name.trim() !== '' && Number.isInteger(days) && days >= 1 && days <= 365;
  const save = (publish: boolean) => () => {
    if (valid) onSave({ name, purposeText, retentionDays: days, fields, publish });
  };
  return (
    <div className="flex flex-col gap-4" role="group" aria-label={t('editor.title')}>
      <Input
        label={t('editor.name')}
        required
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Textarea
        label={t('editor.purpose')}
        hint={t('editor.purposeHint')}
        maxLength={300}
        rows={2}
        value={purposeText}
        onChange={(e) => setPurposeText(e.target.value)}
      />
      <Input
        label={t('editor.retention')}
        hint={t('editor.retentionHint')}
        type="number"
        min={1}
        max={365}
        required
        value={retention}
        onChange={(e) => setRetention(e.target.value)}
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <FormBuilder
          fields={fields}
          onChange={setFields}
          healthTagged={healthTagged}
          disabled={pending}
        />
        <div className="lg:sticky lg:top-4">
          <Preview
            fields={fields}
            purposeText={purposeText}
            retentionDays={Number.isInteger(days) && days >= 1 && days <= 365 ? days : null}
          />
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button variant="secondary" disabled={!valid || pending} onClick={() => save(false)()}>
          {t('editor.saveDraft')}
        </Button>
        <Button
          disabled={!valid || pending}
          loading={pending}
          loadingLabel={t('saving')}
          onClick={() => save(true)()}
        >
          {t('editor.publish')}
        </Button>
      </div>
    </div>
  );
}
