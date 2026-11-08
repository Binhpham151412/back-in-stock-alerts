# Back-in-stock alerts. Zero npm dependencies: Node's built-in HTTP server and SQLite.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /data

# The SQLite database lives in /data. It survives `docker restart`; mount a volume
# (docker run -v restock-data:/data ...) to keep it across container re-creation.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
