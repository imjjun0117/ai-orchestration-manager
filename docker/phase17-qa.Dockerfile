FROM node:24.14.0-bookworm-slim

LABEL org.opencontainers.image.title="ai-manager Phase 17 QA runtime"
LABEL org.opencontainers.image.description="Offline dependency image for registered Phase 17 QA workspaces"

WORKDIR /opt/ai-manager-dependencies
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

ENV CI=true \
    HOME=/tmp \
    NODE_PATH=/opt/ai-manager-dependencies/node_modules \
    NPM_CONFIG_CACHE=/tmp/.npm \
    NO_COLOR=1

WORKDIR /workspace
ENTRYPOINT []
CMD ["node", "--version"]
