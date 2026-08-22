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

RUN chown -R node:node /app
USER node

# No CMD — Railway sets the per-service start command:
#   indexer: pnpm exec tsx services/indexer/src/index.ts
#   keeper : pnpm exec tsx services/keeper/src/scheduler.ts   (pattern A)
# (run from /app so the keeper's fixtures/ lookups resolve)
