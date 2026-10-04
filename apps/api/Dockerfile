# Build context is the repo root: fly deploy (fly.toml points here).
FROM node:22-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production TZ=America/Los_Angeles
RUN apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/board/package.json apps/board/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @lowball/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
ENV PORT=8080
EXPOSE 8080
WORKDIR /app/apps/api
USER node
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
