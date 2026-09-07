# syntax=docker/dockerfile:1
#
# The deployable image. Multi-stage: build with the dev dependencies, ship without them.
#
# git and sops are runtime dependencies here, not build tools: the repository *is* the database
# and every read of a secret shells out to sops.
FROM node:24-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY src/ ./src/
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ARG SOPS_VERSION=3.13.3
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl \
  && ARCH="$(dpkg --print-architecture)" \
  && curl -fsSL -o /usr/local/bin/sops \
     "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.${ARCH}" \
  && chmod +x /usr/local/bin/sops \
  && apt-get purge -y curl && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production CONFIG_ENVIRONMENT=prod
# A distinct uid, because SO_PEERCRED scoping is by uid: this is the identity every consuming
# service's grants are written against.
# Created here, owned by app, so a fresh named volume mounted over them inherits that
# ownership. Docker seeds an empty volume from the image, root-owned if the path did not exist.
RUN useradd -u 10010 -m app \
  && mkdir -p /var/lib/config /run/config \
  && chown -R app:app /var/lib/config /run/config
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./
USER app
EXPOSE 8200
CMD ["node", "dist/server.js"]
