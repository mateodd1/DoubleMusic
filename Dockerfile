# syntax=docker/dockerfile:1
FROM rust:1.98-trixie AS rust-build
WORKDIR /build
COPY core-rust/Cargo.toml core-rust/Cargo.lock ./
COPY core-rust/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked -j 2 && cp target/release/doublemusic-core /doublemusic-core

FROM node:22-bookworm-slim AS catalog
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node docs/*.json ./docs/
COPY --chown=node:node examples/module ./examples/module
COPY --chown=node:node server.js cli.js ./
RUN mkdir -p /data /music && chown node:node /data /music
ENV NODE_ENV=production DATA_DIR=/data MUSIC_DIR=/music PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

# Match the builder's libc; retain Node only for catalog, audio, extensions and CLI.
FROM node:22-trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /music && chown node:node /data /music
WORKDIR /app
COPY --from=catalog --chown=node:node /app /app
COPY --from=rust-build /doublemusic-core /usr/local/bin/doublemusic-core
ENV NODE_ENV=production DATA_DIR=/data MUSIC_DIR=/music PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD ["doublemusic-core", "--healthcheck"]
CMD ["doublemusic-core"]
