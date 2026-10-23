import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Resolve the SQLite database location for the current runtime.
 *
 * - Local: use db/custom.db in the project folder (falls back to DATABASE_URL).
 *
 * - Vercel (read-only bundle filesystem): copy the packaged, pre-seeded
 *   catalog database to /tmp once per server instance and point Prisma at
 *   that copy. Reads serve the seeded Zoko catalog; writes (My List, episode
 *   imports, sync logs) work for the life of the instance and reset when the
 *   instance recycles. Nothing user-facing depends on those writes — the
 *   live catalog data always comes from the Jikan (MyAnimeList) API and the
 *   player streams from Zoko, so a fresh instance simply re-imports.
 *
 * - Turso (libSQL cloud — set TURSO_DATABASE_URL): the whole app talks to
 *   the always-on cloud database instead of any local file. This is the $0
 *   hosting fix for ephemeral-disk platforms (Render free, Vercel): user
 *   writes survive sleeps, redeploys and instance recycling because the
 *   data no longer lives on the host at all. Opt-in and zero-risk — unset
 *   the two TURSO_* vars and the packaged-SQLite behavior takes over.
 */
const PACKAGED_DB = join(process.cwd(), 'db', 'custom.db')

function resolveDatabaseUrl(): string {
  // default: the packaged database inside the project
  process.env.DATABASE_URL ??= `file:${PACKAGED_DB}`

  const onReadOnlyFs =
    process.env.VERCEL === '1' || process.env.DB_FORCE_TMP_COPY === '1'

  if (onReadOnlyFs && existsSync(PACKAGED_DB)) {
    const tmpDb = join(tmpdir(), 'anime-custom.db')
    try {
      if (!existsSync(tmpDb)) copyFileSync(PACKAGED_DB, tmpDb)
      return `file:${tmpDb}`
    } catch {
      // copy failed — fall back to the packaged path (reads still work)
    }
  }

  // An inherited DATABASE_URL may point at a path that doesn't exist in this
  // checkout (the dev harness injects <root>/db/custom.db while the actual
  // database lives at <root>/src/db/custom.db) — SQLite then fails with
  // "error 14: unable to open". Fall back to the packaged file when the
  // configured path is missing; a real deployment always has its path.
  const configured = process.env.DATABASE_URL.replace(/^file:/, '')
  if (configured && !configured.startsWith(':memory:') && !existsSync(configured) && existsSync(PACKAGED_DB)) {
    return `file:${PACKAGED_DB}`
  }

  return process.env.DATABASE_URL
}

process.env.DATABASE_URL = resolveDatabaseUrl()

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createClient(): PrismaClient {
  const tursoUrl = process.env.TURSO_DATABASE_URL
  if (tursoUrl) {
    return new PrismaClient({
      adapter: new PrismaLibSQL({
        url: tursoUrl,
        authToken: process.env.TURSO_AUTH_TOKEN,
      }),
      log: ['warn', 'error'],
    })
  }
  return new PrismaClient({
    log: ['warn', 'error'],
  })
}

export const db = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
