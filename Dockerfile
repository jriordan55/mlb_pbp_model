FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js capture_odds.js scraper.js espn.js ./
COPY public ./public
COPY .env.example ./

ENV NODE_ENV=production
ENV SCRAPER_DATA_DIR=/data
ENV PORT=3000

RUN mkdir -p /data/snapshots

VOLUME ["/data"]

CMD ["node", "scraper.js"]
