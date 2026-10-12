FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true CHROME_PATH=/usr/bin/chromium WHATSAPP_LOGIN_MODE=background WHATSAPP_PROFILE_DIR=/app/data/whatsapp-web WHATSAPP_SESSION_DIR=/app/runtime-sessions WHATSAPP_REMOTE_AUTH_DIR=/app/data/auth-archives
RUN apt-get update && apt-get install -y --no-install-recommends chromium openssl ca-certificates fonts-liberation && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/data /app/runtime-sessions && chown -R node:node /app/data /app/runtime-sessions
USER node
EXPOSE 3000
CMD ["npm", "start"]
