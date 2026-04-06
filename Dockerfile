# Use the official Playwright base image from Microsoft.
# This image comes with Node.js and all necessary browser dependencies pre-installed.
FROM mcr.microsoft.com/playwright:v1.54.1-jammy

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    pulseaudio \
    pulseaudio-utils \
    procps \
  && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container.
WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker's layer caching.
COPY package*.json ./

# Install the project's dependencies.
RUN npm install

# Copy the rest of the application source code into the container.
COPY . .

RUN mkdir -p /app/transcripts

COPY scripts/init_audio.sh /usr/local/bin/init_audio.sh
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/init_audio.sh /usr/local/bin/docker-entrypoint.sh

# Default: orchestrator (control plane + sessions). Legacy bot: docker run ... node src/bot/zoom_bot.js <url> <id>
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/backend/index.js"]
