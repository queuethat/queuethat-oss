// How a deployment's extension routes (extensions.ts) join the built-in ones. Kept apart from
// index.ts so the rules are tested without starting the function.
import type { ProviderWebhookDeps } from './handler.ts';
import type { ExtensionRoute } from './extensions.ts';
import type { WebhookVerifier } from './verify/types.ts';

type Routes = Required<Pick<ProviderWebhookDeps, 'verifiers'>> & Pick<ProviderWebhookDeps, 'handlers' | 'endpointSecrets'>;

/**
 * The built-in routes plus the extension routes. A built-in provider of the same name always wins.
 * An extension route's signing secrets come only from its own `endpointSecrets`: its verifier's
 * `secretsProvider` is dropped, so it can never be pointed at a built-in provider's org secrets.
 */
export function withExtensionRoutes(builtIn: Routes, extra: Record<string, ExtensionRoute>): Routes {
  const own = Object.entries(extra).filter(([name]) => !Object.hasOwn(builtIn.verifiers, name));
  const byName = new Map(own);
  // A view of the verifier without `secretsProvider`. A proxy rather than a spread or a prototype
  // copy: methods run on the original, so class instances with private fields keep working.
  const verifier = (v: WebhookVerifier): WebhookVerifier =>
    new Proxy(v, {
      get: (target, prop) => {
        if (prop === 'secretsProvider') return undefined;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      has: (target, prop) => prop !== 'secretsProvider' && Reflect.has(target, prop),
    });
  return {
    verifiers: { ...builtIn.verifiers, ...Object.fromEntries(own.map(([n, r]) => [n, verifier(r.verifier)])) },
    handlers: { ...Object.fromEntries(own.map(([n, r]) => [n, r.handler])), ...builtIn.handlers },
    endpointSecrets: (provider, endpointId) => {
      const route = byName.get(provider);
      return route ? route.endpointSecrets(endpointId) : builtIn.endpointSecrets(provider, endpointId);
    },
  };
}
