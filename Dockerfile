FROM node:22-alpine3.20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine3.20 AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache curl
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The pages volume is written at runtime, so it must be owned by the user the
# process runs as. Everything else stays read-only.
RUN mkdir -p /data/pages && chown -R node:node /data
USER node

EXPOSE 3013
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:3013/healthz || exit 1
CMD ["node", "dist/index.js"]
