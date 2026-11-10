// Prisma singleton for the REDLINE core — safe to import from Next.js routes,
// the socket mini-service, and the CLI (each resolves @prisma/client through
// the repo root node_modules).
import { PrismaClient } from '@prisma/client'
import path from 'path'
import { ROOT } from './paths'

// Deterministic database location. A RELATIVE `file:` URL in .env is ambiguous
// (Prisma CLI resolves it against the schema dir, env loaders may resolve it
// against anything else) — so at runtime we normalize it to an absolute path
// rooted at the repo. Absolute URLs are honored as explicit operator overrides.
function resolveDbUrl(): string {
  const url = process.env.DATABASE_URL ?? ''
  if (url.startsWith('file:')) {
    const p = url.slice(5)
    const absolute = p.startsWith('/') || p.startsWith('//') || /^[a-zA-Z]:[\\/]/.test(p)
    if (!absolute) return 'file:' + path.join(ROOT, 'db', 'custom.db').replace(/\\/g, '/')
    return url
  }
  if (!url) return 'file:' + path.join(ROOT, 'db', 'custom.db').replace(/\\/g, '/')
  return url // non-sqlite (e.g. postgres) — honor as-is
}
process.env.DATABASE_URL = resolveDbUrl()

const g = globalThis as unknown as { __redlinePrisma?: PrismaClient }

export const db = g.__redlinePrisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') g.__redlinePrisma = db
