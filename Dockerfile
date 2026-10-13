# Clyle backend — Next.js 16 standalone + Prisma/SQLite (38 MB seeded catalog DB)
#
# Build context: repo root (the live app lives in src/).
# Output: a single self-contained server (node server.js) that binds
# 0.0.0.0:$PORT and serves the UI + API with the packaged DB.
#
# Run anywhere Docker runs:
#   docker run -p 3000:3000 ghcr.io/ichial09u/clyle:latest

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Prisma schema must exist before npm ci so the postinstall
# `prisma generate` can build the client.
COPY src/package.json src/package-lock.json ./
COPY src/prisma ./prisma
RUN npm ci

COPY src/ .
RUN npm run build:standalone

# ---------- run ----------
FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# npm run build:standalone already copies .next/static and public/
# into .next/standalone, and outputFileTracingIncludes bundles
# db/custom.db inside the standalone output.
COPY --from=build /app/.next/standalone ./

EXPOSE 3000
CMD ["node", "server.js"]
