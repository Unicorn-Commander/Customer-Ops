# syntax=docker/dockerfile:1
# ---- Build stage ----
FROM node:22-alpine AS build
WORKDIR /app
# Prisma's engines need OpenSSL present to detect libssl + pick the right engine.
RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# Prune dev deps for the runtime image.
RUN npm prune --omit=dev

# ---- Runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Prisma needs libssl; quote PDFs use puppeteer-core with system Chromium.
RUN apk add --no-cache openssl libc6-compat chromium font-noto

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

EXPOSE 3211

# Apply migrations (idempotent) then boot. Migrations run as the owner via
# ADMIN_DATABASE_URL when set, falling back to DATABASE_URL.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
