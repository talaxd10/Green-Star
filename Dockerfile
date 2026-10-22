# The whole system in one image: the office app, the API and the worker.
# Built and run by Render (render.yaml). infra/start.sh says what runs.

FROM node:22-bookworm-slim

# psql runs the migrations. Chromium draws statements as an image and a PDF.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates postgresql-client chromium fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

ENV CI=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN npm install -g pnpm@10.28.0

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @green-star/web build

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium
EXPOSE 3000
CMD ["bash", "infra/start.sh"]
