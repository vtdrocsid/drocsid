# ---- build the Activity bundle ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY activity ./activity
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3005 DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY web ./web
COPY --from=build /app/public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
# Starts as root only to fix /data ownership, then runs drocsid as PUID/PGID (see docker-entrypoint.sh).
VOLUME /data
EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3005)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
