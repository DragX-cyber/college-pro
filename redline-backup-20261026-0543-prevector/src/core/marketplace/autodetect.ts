// ─────────────────────────────────────────────────────────────────────────────
// Tool auto-detection — scans the red-team shell (`which <bin>` inside WSL
// Kali / native bash / PowerShell `where`) for every tool in the marketplace
// catalog and registers what it finds on the agent's tool board.
//
// Registration is exactly the marketplace install path (same manifest JSON in
// InstalledTool), so anything detected teaches the agent its purpose, usage,
// capability scores, pros AND flaws on the next turn — no operator clicks.
// Nothing here executes the tools; detection is `which` only, and it never
// touches the charter (this is host introspection, not engagement activity).
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '../db'
import { audit } from '../audit'
import { whichBin, invalidateWhichCache } from '../os'
import { MARKETPLACE_CATALOG } from './catalog'
import { invalidateRegistry, warmRegistry } from '../tools/registry'
import type { ToolManifest } from '../types'

export interface AutodetectResult {
  /** catalog entries whose binary is present in the red-team shell */
  available: ToolManifest[]
  /** ids detected for the first time this run (freshly registered) */
  registered: string[]
  /** ids already known to the registry before this run */
  alreadyKnown: string[]
  /** catalog ids whose binary is missing */
  missing: string[]
  /** total catalog size */
  scanned: number
}

export async function autodetectTools(): Promise<AutodetectResult> {
  invalidateWhichCache()
  invalidateRegistry()

  const known = new Set((await db.installedTool.findMany()).map((r) => r.id))
  const available: ToolManifest[] = []
  const missing: string[] = []
  const registered: string[] = []
  const alreadyKnown: string[] = []

  for (const manifest of MARKETPLACE_CATALOG) {
    if (whichBin(manifest.detect.bin)) {
      available.push(manifest)
      if (known.has(manifest.id)) {
        alreadyKnown.push(manifest.id)
        continue
      }
      await db.installedTool.upsert({
        where: { id: manifest.id },
        create: { id: manifest.id, manifest: JSON.stringify(manifest), enabled: true },
        update: { enabled: true, manifest: JSON.stringify(manifest) },
      })
      registered.push(manifest.id)
    } else {
      missing.push(manifest.id)
    }
  }

  await warmRegistry()

  if (registered.length) {
    await audit('tools_autodetected', {
      registered,
      alreadyKnown,
      missingCount: missing.length,
      note: 'auto-detected installed tools and registered them on the agent tool board',
    }, { actor: 'autodetect', verdict: 'allowed' })
  }

  return { available, registered, alreadyKnown, missing, scanned: MARKETPLACE_CATALOG.length }
}
