FROM node:22-alpine

RUN apk add --no-cache nmap net-tools iputils iproute2 bash

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

RUN npm prune --omit=dev

RUN mkdir -p /data
VOLUME /data

ENV STATE_FILE=/data/agent-state.json
ENV LOG_LEVEL=info
ENV DISCOVERY_ENABLED=true

CMD ["node", "dist/index.js"]
