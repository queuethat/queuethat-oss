# queue-migrate (2P-OPS3, #209): applies supabase/migrations and publishes supabase/functions to the
# edge-runtime volume, then exits. Build from the repository root:
#   docker build -f deploy/selfhost/migrate/Dockerfile -t queue-migrate .
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# The CLI version is the one the repo develops against (package.json).
ARG SUPABASE_CLI_VERSION=2.122.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl postgresql-client \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --ignore-scripts=false "supabase@${SUPABASE_CLI_VERSION}" \
 && supabase --version

WORKDIR /app
COPY supabase/migrations ./supabase/migrations
COPY supabase/functions ./supabase/functions
COPY supabase/seeds/10_demo_org.sql ./demo-seed.sql
COPY packages/domain/src ./packages/domain/src
COPY deploy/selfhost/functions-main ./deploy/selfhost/functions-main
COPY deploy/selfhost/check-secrets.sh deploy/selfhost/known-demo-keys.sha256 ./
COPY deploy/selfhost/migrate/entrypoint.sh ./entrypoint.sh

ENTRYPOINT ["sh", "/app/entrypoint.sh"]
