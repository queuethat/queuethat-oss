# queue-web (2P-OPS4, #210): the static app served by Caddy, configured when the container starts.
# One image fits every install: nothing install-specific is baked in; docker/entrypoint.sh writes
# /srv/config.js from the environment (apps/web/src/lib/config.ts reads it before the bundle).
# Build from the repository root:  docker build -f apps/web/Dockerfile -t queue-web .
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
COPY packages/ui/package.json packages/ui/
COPY packages/providers/package.json packages/providers/
COPY packages/db-types/package.json packages/db-types/
RUN pnpm install --frozen-lockfile --filter @qm/web...
COPY apps/web apps/web
COPY packages packages
# The starter waivers that forms/waivers/starters.ts bundles.
COPY supabase/catalog/waivers supabase/catalog/waivers
# No VITE_* values: the build must be the same for everyone. `build` also fails on a leaked secret.
ENV APP_VERSION=
RUN pnpm --filter @qm/web build

FROM caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
RUN apk add --no-cache openssl
COPY --from=build /repo/apps/web/dist /srv
COPY deploy/selfhost/Caddyfile /etc/caddy/Caddyfile
COPY deploy/selfhost/check-secrets.sh deploy/selfhost/known-demo-keys.sha256 /usr/local/share/queue/
COPY apps/web/docker/entrypoint.sh /usr/local/bin/queue-entrypoint
EXPOSE 80 443
HEALTHCHECK --interval=10s --timeout=5s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1:8081/healthz || exit 1
ENTRYPOINT ["sh", "/usr/local/bin/queue-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
