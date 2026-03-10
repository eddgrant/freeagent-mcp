FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
COPY src/ ./src/

RUN npm install
RUN npm run build

FROM node:20-slim AS release

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/package*.json ./

ENV NODE_ENV=production

# tini is a lightweight init process that runs as PID 1. Without it, Node.js
# receives PID 1 responsibilities it wasn't designed for: the kernel won't
# deliver default signal handlers to PID 1, so SIGTERM (sent by `docker stop`)
# is silently ignored and Docker must hard-kill the container after a timeout.
# tini forwards signals to the child process and reaps any zombie processes.
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini && \
    rm -rf /var/lib/apt/lists/*

RUN npm ci --ignore-scripts --omit=dev

RUN addgroup --system --gid 1001 mcp && \
    adduser --system --uid 1001 --ingroup mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

ENTRYPOINT ["tini", "--", "node", "build/index.js"]
