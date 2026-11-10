import { Button } from '@qm/ui';

/**
 * What a form shows when its Turnstile check can't run (see `Turnstile`'s `onProblem`): the
 * button behind it stays disabled, so say why and offer a reload (#576). The caller passes the
 * translated copy, since each area words it for its own audience.
 */
export function CaptchaProblem({ message, reloadLabel }: { message: string; reloadLabel: string }) {
  return (
    <div role="alert" className="space-y-3 rounded-card bg-warning-soft p-4">
      <p className="font-medium text-warning-strong">{message}</p>
      <Button variant="secondary" onClick={() => window.location.reload()}>
        {reloadLabel}
      </Button>
    </div>
  );
}
