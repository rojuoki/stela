FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src/lib ./src/lib
COPY scripts ./scripts
COPY migrations/io ./migrations/io
RUN mkdir -p /app/results/io-pg-worker && chown -R node:node /app/results
USER node
ENV NODE_ENV=production PYTHONUNBUFFERED=1 STELA_IO_CONCURRENCY=8
CMD ["node", "--import", "tsx", "scripts/io-pg-worker.ts"]
