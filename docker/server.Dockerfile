FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile=false
RUN pnpm -r build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app .
EXPOSE 4000
CMD ["node", "apps/server/dist/main.js"]
