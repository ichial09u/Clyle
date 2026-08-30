import { PrismaClient } from '@prisma/client'
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

  return process.env.DATABASE_URL
}

process.env.DATABASE_URL = resolveDatabaseUrl()

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
