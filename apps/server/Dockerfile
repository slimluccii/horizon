# syntax=docker/dockerfile:1.7

# ---------- builder: install workspaces incl. native modules ----------
FROM node:22-bookworm-slim AS builder

# Build toolchain for better-sqlite3 native compile (fallback if no prebuilt)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace manifests first for better layer caching
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY libs/sdk/package.json libs/sdk/
COPY apps/web/package.json apps/web/

# Install only what the server workspace needs (tsx is a server dependency).
RUN npm ci --workspace=@horizon/server --include-workspace-root

# Now copy source. libs/sdk is consumed as raw TS (its package "exports" point
# at src/*.ts), so its source must be present for both the typecheck below and
# the tsx runtime — not just its package.json.
COPY tsconfig.base.json ./
COPY libs/sdk ./libs/sdk
COPY apps/server ./apps/server

# Sanity: typecheck (catches build-time errors before runtime image)
RUN npm --workspace=@horizon/server run typecheck

# ---------- webbuilder: build the web UI (apps/web/dist) ----------
FROM node:22-bookworm-slim AS webbuilder
WORKDIR /app

# Manifests first for layer caching.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY libs/sdk/package.json libs/sdk/
COPY apps/web/package.json apps/web/

# Web workspace + its build toolchain (vite, plugin-react, tsc) — devDeps needed.
RUN npm ci --workspace=@horizon/web --include-workspace-root

COPY tsconfig.base.json ./
COPY libs/sdk ./libs/sdk
COPY apps/web ./apps/web

# Produces apps/web/dist (static SPA bundle).
RUN npm --workspace=@horizon/web run build

# ---------- runtime: ffmpeg + node + app + web UI ----------
FROM node:22-bookworm-slim AS runtime

# ffmpeg for transcoding; tini for proper PID 1 signal handling
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring in installed deps + source from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/server ./apps/server
COPY --from=builder /app/libs/sdk ./libs/sdk
COPY --from=builder /app/tsconfig.base.json ./
COPY --from=builder /app/package.json ./

# Built web UI, served same-origin by the server (Plex/Jellyfin style).
COPY --from=webbuilder /app/apps/web/dist ./apps/web/dist

# Persistent state lives here (DB + transcode cache). Mount a volume.
RUN mkdir -p /data /media/movies /media/shows
VOLUME ["/data"]

ENV NODE_ENV=production \
    HORIZON_PORT=7777 \
    HORIZON_MOVIES_ROOT=/media/movies \
    HORIZON_SHOWS_ROOT=/media/shows \
    HORIZON_CACHE_DIR=/data/cache \
    HORIZON_DB_PATH=/data/horizon.db \
    HORIZON_WEB_DIR=/app/apps/web/dist \
    HORIZON_SERVE_WEB=1

EXPOSE 7777

# Healthcheck hits the server's /health route
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HORIZON_PORT||7777)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "node_modules/.bin/tsx", "apps/server/src/index.ts"]
