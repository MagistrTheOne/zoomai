# NULLXES AI Meeting — production deploy image
# Build from repository root:
#   docker build -f deploy/Dockerfile -t nullxes-ai-meeting:latest .
#
# Uses npm ci --omit=dev (playwright-core is a runtime dependency in package.json).

FROM mcr.microsoft.com/playwright:v1.54.1-jammy

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    pulseaudio \
    pulseaudio-utils \
    procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY examples ./examples
COPY playwright.config.js ./

RUN mkdir -p /app/transcripts

COPY scripts/init_audio.sh /usr/local/bin/init_audio.sh
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/init_audio.sh /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production

EXPOSE 3000 8080 47001

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/healthz',(r)=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/backend/index.js"]
