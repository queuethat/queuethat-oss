// 4-INT1 (#395): integration-sync, the only sender of CRM and POS updates. Kicked by pg_net after a
// served visit is queued and by pg_cron every minute. Claims due jobs with a lease (the database has
// already filtered out guests without marketing consent), hands each to the adapter for its provider
// and reports a short outcome code. Tokens an adapter refreshed are stored before the report, so a
// lost response never strands a rotated token. An Edge Function because only it may hold vendor
// credentials and call out (technical-design.md 3.5, rule 3).
//
// POST (Authorization: Bearer <DISPATCH_SECRET>, as dispatch-notifications) -> 200 { claimed, delivered, failed }
import type { IntegrationAdapter, IntegrationJob, RefreshedTokens } from '@qm/providers';
import { constantTimeEqual } from '../_shared/hmac.ts';

export interface IntegrationReport {
  status: 'delivered' | 'failed';
  /** A short code, never a vendor response body. */
  error?: string;
  retryable?: boolean;
}

export interface IntegrationSyncDeps {
  adapters: Record<string, IntegrationAdapter>;
  secret: string;
  claim(limit: number, leaseSeconds: number): Promise<IntegrationJob[]>;
  report(jobId: string, result: IntegrationReport): Promise<void>;
  /** api.save_integration_tokens */
  saveTokens(orgId: string, channel: 'pos' | 'crm', tokens: RefreshedTokens): Promise<void>;
  log?(line: string): void;
}

const BATCH = 10;
const LEASE_SECONDS = 300;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function runOne(job: IntegrationJob, deps: IntegrationSyncDeps): Promise<'delivered' | 'failed'> {
  const adapter = Object.hasOwn(deps.adapters, job.provider) ? deps.adapters[job.provider] : undefined;
  let report: IntegrationReport;
  if (!adapter) {
    report = { status: 'failed', error: 'no_adapter', retryable: false };
  } else {
    try {
      const r = await adapter.sync(job);
      if (r.refreshed) await deps.saveTokens(job.org_id, job.channel, r.refreshed);
      report = r.status === 'delivered' ? { status: 'delivered' } : { status: 'failed', error: r.error, retryable: r.retryable };
    } catch {
      // Nothing from the exception: vendor errors can carry customer data.
      report = { status: 'failed', error: 'unknown', retryable: true };
    }
  }
  await deps.report(job.id, report);
  deps.log?.(`integration ${job.provider} job ${job.id}: ${report.status}${report.error ? ` ${report.error}` : ''}`);
  return report.status;
}

export function createIntegrationSyncHandler(deps: IntegrationSyncDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const given = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
    if (!constantTimeEqual(given, deps.secret)) return json(401, { error: 'unauthorized' });
    const jobs = await deps.claim(BATCH, LEASE_SECONDS);
    const tally = { claimed: jobs.length, delivered: 0, failed: 0 };
    for (const job of jobs) tally[await runOne(job, deps)]++;
    return json(200, tally);
  };
}
