FROM node:24-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY vite.landing.config.ts ./
COPY src ./src
COPY frontend ./frontend
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/tmp/openbrowse \
    XDG_CONFIG_HOME=/tmp/openbrowse/config \
    XDG_CACHE_HOME=/tmp/openbrowse/cache \
    XDG_RUNTIME_DIR=/tmp/openbrowse/runtime
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY deploy/start-with-vnc.sh ./deploy/start-with-vnc.sh
RUN npx playwright install --with-deps chromium firefox webkit \
 && apt-get update \
 && apt-get install -y --no-install-recommends xvfb x11vnc websockify \
 && rm -rf /var/lib/apt/lists/* \
 && chmod +x /app/deploy/start-with-vnc.sh \
 && useradd --create-home --uid 10001 openbrowse \
 && mkdir -p /data /tmp/openbrowse /tmp/.X11-unix /ms-playwright \
 && chmod 1777 /tmp/.X11-unix \
 && chown -R openbrowse:openbrowse /app /data /tmp/openbrowse /ms-playwright
USER 10001
EXPOSE 3000
CMD ["/app/deploy/start-with-vnc.sh"]
