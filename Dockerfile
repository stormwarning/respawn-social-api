# Single-stage build on the official Deno image.
# Deno runs TypeScript directly, so there's no separate compile step or dist/.

FROM denoland/deno:latest AS base
WORKDIR /app
ENV NODE_ENV=production

# Cache dependencies first (cached layer unless these files change).
# deno.json + package.json describe the deps; `deno install` populates node_modules.
COPY deno.json deno.lock* package.json ./
RUN deno install

# App source + migration SQL.
COPY . .

# Pre-compile/cache the entry point so startup is fast and offline-capable.
RUN deno cache src/index.ts

EXPOSE 3000

# Run with the same explicit permissions as the `start` task.
# (Deno denies network/env/fs access unless granted.)
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-sys", "src/index.ts"]
