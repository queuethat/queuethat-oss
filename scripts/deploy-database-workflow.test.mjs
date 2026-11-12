// Guards .github/workflows/deploy-database.yml, the manual check-and-apply tool for the production
// database (docs/ops/database-deploy.md). Supabase's GitHub integration deploys on a push to main,
// so this workflow must never also run on one. These are the properties a later edit must not lose.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const text = readFileSync(
  new URL('../.github/workflows/deploy-database.yml', import.meta.url),
  'utf8',
);
const workflow = parse(text);
const job = workflow.jobs.migrate;
const commands = job.steps.map((step) => step.run ?? '').join('\n');

describe('deploy-database workflow', () => {
  it('is the only job and is bound to the production environment', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['migrate']);
    expect(job.environment).toBe('production');
  });

  it('never forces out-of-order migrations and never repairs the history', () => {
    expect(text).not.toContain('--include-all');
    expect(text).not.toMatch(/migration\s+repair/);
    expect(commands).not.toMatch(/\brepair\b/);
  });

  it('never cancels a run in progress', () => {
    expect(workflow.concurrency).toEqual({ group: 'deploy-database', 'cancel-in-progress': false });
  });

  it('runs only by hand, never on a push, and as a dry run by default', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on).not.toHaveProperty('push');
    expect(text).not.toMatch(/^\s*(push|pull_request|schedule)\s*:/m);
    expect(workflow.on.workflow_dispatch.inputs.dry_run).toMatchObject({
      type: 'boolean',
      default: true,
    });
  });

  it('applies only when dry_run is cleared', () => {
    expect(job.steps[0].env.APPLY).toBe('${{ inputs.dry_run == false }}');
  });

  it('holds read-only repository permissions and pins every action to a commit', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toBeUndefined();
    for (const step of job.steps.filter((s) => s.uses)) {
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('checks the secrets first and gates every later step on that check', () => {
    const [first, ...rest] = job.steps;
    expect(first.id).toBe('plan');
    expect(first.run).toContain('configured=false');
    for (const step of rest) {
      expect(String(step.if)).toMatch(/steps\.plan\.outputs\.|steps\.link\.outcome == 'success'/);
    }
  });

  it('applies only after the guards and the dry run, with the pinned CLI', () => {
    const order = ['check-migrations.mjs', 'check-hosted-functions.mjs', '--dry-run', '--yes'];
    const at = order.map((needle) => commands.indexOf(needle));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(commands).not.toMatch(/(?<!pnpm exec )supabase (link|db|migration)\b/);
  });

  it('never prints a secret', () => {
    expect(commands).not.toMatch(/echo[^\n]*\$\{?SUPABASE_(ACCESS_TOKEN|DB_PASSWORD)/);
    expect(commands).not.toContain('secrets.');
  });
});
