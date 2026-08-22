# Backend services image (indexer + keeper) for Railway — pattern A.
# One workspace image; the per-service start command is set in Railway.
# tsx runs the TS directly (no build step) — the image is source + node_modules.
FROM node:22-bookworm-slim

# better-sqlite3 (indexer) is a native module — needs a toolchain at install time.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.15.1 --activate
WORKDIR /app

# Source only — .dockerignore keeps out secrets, node_modules, target, fixtures,
# and the frontend/ source (this is a backend-only image).
COPY . .

# Drop the frontend workspace member (its source isn't in the image) so the
# backend install doesn't require it, then install packages/sdk + services/*.
RUN sed -i '/frontend/d' pnpm-workspace.yaml \
    && pnpm install --prod=false

RUN mkdir -p /data && chown -R node:node /app /data
USER node

# One image, two services: SERVICE_ENTRY (an env var set per Railway service)
# picks which process to run. `exec` so SIGTERM reaches node (keeper graceful
# drain). Runs from /app so the keeper's fixtures/ lookups resolve.
#   indexer: SERVICE_ENTRY=services/indexer/src/index.ts   (default)
#   keeper : SERVICE_ENTRY=services/keeper/src/scheduler.ts
ENV SERVICE_ENTRY=services/indexer/src/index.ts
CMD ["sh", "-c", "exec node_modules/.bin/tsx \"$SERVICE_ENTRY\""]
