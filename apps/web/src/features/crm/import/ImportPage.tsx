import { Badge, Button, Card, Input, Select, Spinner } from '@qm/ui';
import { Link } from '@tanstack/react-router';
import { useState, type ChangeEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import { downloadCsv, parseCsv, toCsv } from '../csv.ts';
import { ExportGuests } from '../export/ExportGuests.tsx';
import { useImportGuests, type ImportResult } from './api.ts';
import {
  batches,
  guessMapping,
  IMPORT_FIELDS,
  previewProblem,
  toImportRow,
  type Mapping,
} from './mapping.ts';

interface Loaded {
  headers: string[];
  records: string[][];
}

/** Admins export the guest list and import a CSV with column mapping and a preview (2B-C6, #305). */
export function ImportPage() {
  const { t } = useTranslation('crm');
  const role = useCurrentOrg()?.role;
  const allowed = role === 'owner' || role === 'admin';
  const [file, setFile] = useState<Loaded | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [results, setResults] = useState<{ line: number; result: ImportResult }[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const importer = useImportGuests();

  if (!allowed) {
    return (
      <Card className="mx-auto mt-8 max-w-3xl">
        <p role="alert">{t('transfer.noAccess')}</p>
      </Card>
    );
  }

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    if (!picked) return;
    const [headers = [], ...records] = parseCsv(await picked.text());
    setFile({ headers, records });
    setMapping(guessMapping(headers));
    setResults(null);
    setProgress(null);
    setFailed(false);
  };

  const rows = file && mapping ? file.records.map((r) => toImportRow(r, mapping)) : [];
  const problems = rows.map(previewProblem);
  const invalid = problems.filter(Boolean).length;

  const run = async () => {
    setFailed(false);
    setResults([]);
    const out: { line: number; result: ImportResult }[] = [];
    let offset = 0;
    const parts = batches(rows);
    try {
      for (const part of parts) {
        const res = await importer.mutateAsync(part);
        for (const r of res) out.push({ line: offset + r.rowNo + 1, result: r });
        offset += part.length;
        setProgress({ done: offset, total: rows.length });
        setResults([...out]);
      }
    } catch {
      setFailed(true);
    }
  };

  const summary = (outcome: string) =>
    results?.filter((r) => r.result.outcome === outcome).length ?? 0;
  const finished = results !== null && progress?.done === rows.length && rows.length > 0;

  return (
    <Card className="mx-auto mt-8 flex max-w-4xl flex-col gap-6">
      <Link to="/admin/guests" className="inline-flex min-h-target items-center underline">
        {t('transfer.back')}
      </Link>
      <h1 className="text-2xl font-semibold">{t('transfer.title')}</h1>
      <ExportGuests />

      <section aria-labelledby="import-h" className="flex flex-col gap-3">
        <h2 id="import-h" className="text-xl font-semibold">
          {t('import.title')}
        </h2>
        <p className="text-muted">{t('import.intro')}</p>
        <Input label={t('import.file')} type="file" accept=".csv,text/csv" onChange={choose} />
      </section>

      {file && mapping ? (
        <>
          <section aria-labelledby="map-h" className="flex flex-col gap-3">
            <h2 id="map-h" className="text-xl font-semibold">
              {t('import.mapping')}
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              {IMPORT_FIELDS.map((f) => (
                <Select
                  key={f}
                  label={t(`import.fields.${f}`)}
                  value={String(mapping[f])}
                  onChange={(event) => setMapping({ ...mapping, [f]: Number(event.target.value) })}
                >
                  <option value="-1">{t('import.unmapped')}</option>
                  {file.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h}
                    </option>
                  ))}
                </Select>
              ))}
            </div>
          </section>

          <section aria-labelledby="prev-h" className="flex flex-col gap-3">
            <h2 id="prev-h" className="text-xl font-semibold">
              {t('import.preview')}
            </h2>
            <p data-testid="import-summary">
              {t('import.rows', { count: rows.length })} {t('import.invalid', { count: invalid })}
            </p>
            <table className="w-full text-left">
              <caption className="sr-only">{t('import.preview')}</caption>
              <thead>
                <tr className="text-muted">
                  <th scope="col">{t('import.line')}</th>
                  <th scope="col">{t('import.fields.name')}</th>
                  <th scope="col">{t('import.fields.phone')}</th>
                  <th scope="col">{t('import.fields.email')}</th>
                  <th scope="col">{t('import.problem')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 5).map((r, i) => (
                  <tr key={i} className="border-t border-border">
                    <td>{i + 2}</td>
                    <td>{r.name}</td>
                    <td>{r.phone}</td>
                    <td>{r.email}</td>
                    <td>{problems[i] ? t(`import.problems.${problems[i]}`) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button
              className="self-start"
              disabled={rows.length === rows.length - invalid && rows.length === 0}
              loading={importer.isPending}
              loadingLabel={t('import.running')}
              onClick={run}
            >
              {t('import.start', { count: rows.length - invalid })}
            </Button>
          </section>
        </>
      ) : null}

      {importer.isPending && !progress ? <Spinner label={t('import.running')} /> : null}
      {progress ? (
        <p role="status" data-testid="import-progress">
          {t('import.progress', { done: progress.done, total: progress.total })}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('import.failed')}
        </p>
      ) : null}
      {finished ? (
        <section aria-labelledby="res-h" className="flex flex-col gap-3">
          <h2 id="res-h" className="text-xl font-semibold">
            {t('import.results')}
          </h2>
          <p className="flex flex-wrap gap-2" data-testid="import-results">
            <Badge tone="success">{t('import.created', { count: summary('created') })}</Badge>
            <Badge tone="info">{t('import.matched', { count: summary('matched') })}</Badge>
            <Badge tone="warning">{t('import.skipped', { count: summary('invalid') })}</Badge>
          </p>
          <Button
            variant="secondary"
            className="self-start"
            onClick={() =>
              downloadCsv(
                toCsv([
                  ['line', 'outcome', 'note'],
                  ...results.map((r) => [r.line, r.result.outcome, r.result.error]),
                ]),
                'guest-import-results.csv',
              )
            }
          >
            {t('import.download')}
          </Button>
        </section>
      ) : null}
    </Card>
  );
}
