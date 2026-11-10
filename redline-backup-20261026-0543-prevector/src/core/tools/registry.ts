// Registry — the agent's live tool board: builtins + marketplace installs,
// each with resolved availability (which <bin> inside the red-team shell).
import { db } from '../db'
import { whichBin, invalidateWhichCache } from '../os'
import { BUILTIN_TOOLS } from './builtins'
import { MARKETPLACE_CATALOG } from '../marketplace/catalog'
import type { ToolManifest } from '../types'

let cache: { at: number; tools: ToolManifest[] } | null = null
const TTL = 20_000

export function invalidateRegistry() {
  cache = null
  invalidateWhichCache()
}

export function getRegistry(opts: { resolveAvailability?: boolean } = {}): ToolManifest[] {
  const resolveAvailability = opts.resolveAvailability ?? false
  if (cache && Date.now() - cache.at < TTL && !resolveAvailability) return cache.tools

  const tools: ToolManifest[] = [...BUILTIN_TOOLS]
  // Installed marketplace tools are stored as JSON manifests — no catalog
  // dependency, so user-local catalogs stay portable.
  const installed = safeInstalled()
  for (const row of installed) {
    if (!row.enabled) continue
    try {
      tools.push(JSON.parse(row.manifest) as ToolManifest)
    } catch { /* corrupt manifest — skip */ }
  }
  if (resolveAvailability) {
    for (const t of tools) t.availability = whichBin(t.detect.bin) ? 'available' : 'missing'
    // don't cache availability-resolved sets (which() has its own cache)
    return tools
  }
  cache = { at: Date.now(), tools }
  return tools
}

function safeInstalled() {
  try {
    return require_sync_installed()
  } catch {
    return [] as { id: string; enabled: boolean; manifest: string }[]
  }
}

// tiny sync helper — Prisma is async, but the registry is used in sync
// contexts (prompt building). We keep a warm snapshot refreshed on writes.
let installedSnapshot: { id: string; enabled: boolean; manifest: string }[] | null = null

export function setInstalledSnapshot(rows: { id: string; enabled: boolean; manifest: string }[]) {
  installedSnapshot = rows
  cache = null
}

function require_sync_installed() {
  if (installedSnapshot) return installedSnapshot
  throw new Error('snapshot not warmed')
}

export async function warmRegistry() {
  const rows = await db.installedTool.findMany()
  installedSnapshot = rows.map((r) => ({ id: r.id, enabled: r.enabled, manifest: r.manifest }))
  cache = null
  return getRegistry()
}

export function toolById(id: string, tools: ToolManifest[] = getRegistry()): ToolManifest | undefined {
  return tools.find((t) => t.id === id)
}

export function catalogById(id: string): ToolManifest | undefined {
  return MARKETPLACE_CATALOG.find((t) => t.id === id)
}

/** Tools available in the red-team shell right now. */
export function availableTools(): ToolManifest[] {
  return getRegistry({ resolveAvailability: true }).filter((t) => t.availability === 'available')
}
