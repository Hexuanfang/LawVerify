FROM node:22-alpine AS build
WORKDIR /build
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --registry=$NPM_REGISTRY
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
# release-service reads installers from <cloud-server>/../app/release.
WORKDIR /opt/lawverify/cloud-server
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./
COPY migrations ./migrations
RUN mkdir -p /opt/lawverify/app/release .data && chown -R node:node /opt/lawverify
USER node
EXPOSE 8788
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8788/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
