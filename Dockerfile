# syntax=docker/dockerfile:1
FROM rust:1.98.0-bookworm AS rust-build
RUN apt-get update && apt-get install -y --no-install-recommends musl-tools python3 \
    && rm -rf /var/lib/apt/lists/* \
    && rustup target add "$(rustc -vV | sed -n 's/^host: //p' | sed 's/-gnu$/-musl/')"
WORKDIR /build
COPY core-rust/Cargo.toml core-rust/Cargo.lock ./
COPY core-rust/src ./src
COPY packaging/collect-licenses.py /collect-licenses.py
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    target=$(rustc -vV | sed -n 's/^host: //p' | sed 's/-gnu$/-musl/') && \
    RUSTFLAGS="-C target-feature=+crt-static -C link-self-contained=yes" \
    CC=musl-gcc CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
    cargo build --release --target "$target" --locked -j 2 && \
    cp "target/$target/release/doublemusic-core" /doublemusic-core && \
    if readelf -l /doublemusic-core | grep -q INTERP; then echo "Core must be statically linked" >&2; exit 1; fi && \
    python3 /collect-licenses.py /rust-licenses && \
    cp /usr/share/doc/musl/copyright /rust-licenses/MUSL-COPYRIGHT

FROM node:22.23.4-bookworm-slim AS catalog
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

FROM rust-build AS package-build
RUN apt-get update && apt-get install -y --no-install-recommends rpm xz-utils \
    && rm -rf /var/lib/apt/lists/*
COPY --from=catalog /app /build/app
COPY --from=catalog /usr/local/bin/node /build/node/node
COPY --from=catalog /usr/local/LICENSE /build/node/LICENSE
COPY packaging /build/packaging
COPY README.md README-es.md /build/
COPY docs /build/docs
ARG SOURCE_REVISION=local-build
ENV SOURCE_REVISION=$SOURCE_REVISION
RUN python3 /build/packaging/build.py --output /out

FROM scratch AS packages
COPY --from=package-build /out/ /

FROM catalog AS runtime
COPY --from=rust-build /doublemusic-core /usr/local/bin/doublemusic-core
COPY --from=rust-build /rust-licenses /usr/share/doc/doublemusic/licenses/rust
ARG VERSION=1.4.1
ARG SOURCE_REVISION=local-build
LABEL org.opencontainers.image.title="DoubleMusic" \
      org.opencontainers.image.description="Local music library server with optional external API connections" \
      org.opencontainers.image.source="https://github.com/mateodd1/DoubleMusic" \
      org.opencontainers.image.url="https://github.com/mateodd1/DoubleMusic" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$SOURCE_REVISION
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD ["doublemusic-core", "--healthcheck"]
CMD ["doublemusic-core"]
