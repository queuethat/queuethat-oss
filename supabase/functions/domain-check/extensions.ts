// What a deployment adds to domain-check without editing it. This repository adds nothing; a
// deployment that has to prepare a hostname before it can be served over HTTPS (for example, add
// it to its hosting provider) ships its own copy of this file. Self-hosted Caddy needs neither: it
// asks the GET route of this function on the first request. Keep the export names and shapes:
// changing them breaks every such deployment.

export type DomainStatus = 'pending' | 'verified' | 'failed' | 'disabled';

export interface DomainStatusChange {
  domainId: string;
  orgId: string;
  hostname: string;
  from: DomainStatus;
  to: DomainStatus;
}

/**
 * Called once after a check changes a domain's status (pending or failed to verified, verified to
 * disabled, and so on), never after a check that leaves it as it was. A removal is not reported
 * here (it is an RPC, not a check): see `onRecheckComplete`. All values come from the database,
 * none from a request. A hook that throws is logged and ignored: it never changes the check's
 * result, the domain's status or its failure count.
 */
export function onDomainStatusChange(_change: DomainStatusChange): Promise<void> {
  return Promise.resolve();
}

/**
 * Called at the end of every daily re-check with every hostname that is verified at that moment.
 * A deployment keeps its own list in step with this one (adds what is missing, removes what is no
 * longer verified, including domains an owner deleted), so a missed `onDomainStatusChange` heals
 * within a day. Same failure rule as above.
 */
export function onRecheckComplete(_verifiedHostnames: readonly string[]): Promise<void> {
  return Promise.resolve();
}
