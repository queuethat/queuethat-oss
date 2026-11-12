// What a deployment adds to provider-webhook without editing it. This repository adds nothing; a
// deployment with a sender of its own that has no org row (a shared number, see
// dispatch-notifications/extensions.ts) ships its own copy of this file.
// Keep the export's name and shape: changing them breaks every such deployment.
import type { EndpointSecrets, WebhookHandler } from './handler.ts';
import type { WebhookVerifier } from './verify/types.ts';

/** One route, `/provider-webhook/<name>/<endpoint>`. A built-in provider of the same name wins. */
export interface ExtensionRoute {
  /** Its `secretsProvider` is ignored: the route's secrets come only from `endpointSecrets`. */
  verifier: WebhookVerifier;
  handler: WebhookHandler;
  /** The endpoint's signing secrets (orgId null for a deployment-wide route), or null when unknown. */
  endpointSecrets(endpointId: string): Promise<EndpointSecrets | null>;
}

export interface ExtensionRouteDeps {
  /** Calls an api.* function with the service role; throws on error. */
  rpc(fn: string, args: Record<string, unknown>): Promise<unknown>;
  env(name: string): string | undefined;
}

/** The deployment's extra routes by name. None here. */
export function extensionRoutes(_deps: ExtensionRouteDeps): Record<string, ExtensionRoute> {
  return {};
}
