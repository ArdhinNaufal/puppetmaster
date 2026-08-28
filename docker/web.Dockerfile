FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build

RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui
COPY apps/web ./apps/web

RUN pnpm install --filter @puppetmaster/web... --frozen-lockfile
RUN pnpm --filter @puppetmaster/web... build

FROM nginx:1.27.5-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

COPY docker/web-nginx.conf /etc/nginx/nginx.conf
COPY docker/web-security-headers.conf /etc/nginx/web-security-headers.conf
COPY --from=build --chown=101:101 /app/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
USER 101:101
STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
