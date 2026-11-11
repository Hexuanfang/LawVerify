FROM node:22-alpine AS build
WORKDIR /build
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --registry=$NPM_REGISTRY
COPY . .
# VITE_* values are baked into the bundle at build time.
ARG VITE_SITE_URL=
ARG VITE_COMPANY_NAME=
ARG VITE_BAIDU_TONGJI_ID=
ARG VITE_ICP_NUMBER=
ARG VITE_TERMS_URL=
ARG VITE_PRIVACY_URL=
ENV VITE_SITE_URL=$VITE_SITE_URL \
    VITE_COMPANY_NAME=$VITE_COMPANY_NAME \
    VITE_BAIDU_TONGJI_ID=$VITE_BAIDU_TONGJI_ID \
    VITE_ICP_NUMBER=$VITE_ICP_NUMBER \
    VITE_TERMS_URL=$VITE_TERMS_URL \
    VITE_PRIVACY_URL=$VITE_PRIVACY_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
