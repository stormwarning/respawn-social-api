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

EXPOSE 8000

# Run with the same explicit permissions as the `start` task.
# (Deno denies network/env/fs access unless granted.)
#
# This list MUST match `deno.json`'s `start` task. It is duplicated rather than
# invoked as `deno task start` so Railway's SIGTERM reaches the server process
# directly, with no `deno task` wrapper in between to forward it — the shutdown
# handler needs the signal to stop the derive worker cleanly.
#
# `src/deploy.test.ts` asserts the two lists stay identical. They drifted once:
# --allow-ffi was added to the tasks for sharp and missed here, and the
# deployment died at boot with an error blaming sharp's install rather than the
# missing flag.
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-sys", "--allow-ffi", "src/index.ts"]
