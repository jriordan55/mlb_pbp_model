FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js espn.js telegram.js odds_value.js market_filters.js capture_odds.js scraper.js ./
COPY markov ./markov
COPY pythag ./pythag
COPY public ./public
COPY .env.example ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV SCRAPER_DATA_DIR=/data

RUN mkdir -p /data/snapshots

EXPOSE 3000
VOLUME ["/data"]

# Default: live web dashboard. Override for scraper worker: ["node","scraper.js"]
CMD ["node", "server.js"]
