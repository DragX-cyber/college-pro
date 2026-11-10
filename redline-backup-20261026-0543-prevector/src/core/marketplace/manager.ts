// Marketplace manager — operator installs a tool from the catalog; the tool
// is registered in the agent's tool board automatically (its purpose, usage
// and capability profile are injected into the next system prompt), and the
// event is audited + broadcast to every connected console.
import { db } from '../db'
import { audit } from '../audit'
import { invalidateOSCache } from '../os'
import { MARKETPLACE_CATALOG } from './catalog'
import { invalidateRegistry, setInstalledSnapshot, warmRegistry } from '../tools/registry'
import { selectStrategy } from '../tools/selector'
import type { ToolManifest, ToolStrategy } from '../types'

export async function getMarketplace() {
  const installedRows = await db.installedTool.findMany()
  const installedIds = new Set(installedRows.map((r) => r.id))
  return MARKETPLACE_CATALOG.map((t) => ({ ...t, installed: installedIds.has(t.id) }))
}

export async function installTool(id: string, opts: { systemInstall?: boolean } = {}) {
  const manifest = MARKETPLACE_CATALOG.find((t) => t.id === id)
  if (!manifest) return { ok: false as const, error: 'unknown tool id' }

  await db.installedTool.upsert({
    where: { id },
    create: { id, manifest: JSON.stringify(manifest), enabled: true },
    update: { enabled: true, manifest: JSON.stringify(manifest) },
  })
  await warmRegistry()
  await audit('tool_registered', {
    tool: manifest.id,
    name: manifest.name,
    category: manifest.category,
    purpose: manifest.purpose,
    usage: manifest.usage,
    systemInstall: !!opts.systemInstall,
  }, { actor: 'operator', verdict: 'allowed' })

  // Optional: attempt the real system install inside WSL (operator choice).
  let systemInstallOutput: string | null = null
  if (opts.systemInstall && manifest.install.wsl) {
    // Intentionally executed only on operator request — this path is never
    // reachable by the agent.
    try {
      const { execSync } = await import('child_process')
      const osMod = await import('../os')
      const osInfo = osMod.detectOS()
      if (osInfo.exec.kind === 'wsl-bash') {
        systemInstallOutput = execSync(
          `wsl -d ${osInfo.wsl.preferred} -- ${manifest.install.wsl}`,
          { timeout: 300_000, encoding: 'utf8' }
        ).slice(0, 4000)
      } else if (osInfo.exec.kind === 'native-bash') {
        systemInstallOutput = execSync(manifest.install.wsl, { timeout: 300_000, encoding: 'utf8' }).slice(0, 4000)
      } else {
        systemInstallOutput = 'system install only supported inside WSL/bash environments'
      }
      invalidateOSCache()
      invalidateRegistry()
      await warmRegistry()
    } catch (e: any) {
      systemInstallOutput = `system install failed: ${e?.message ?? e}`
    }
  }

  // Find the task this tool is best at, so the console can say what changed.
  const bestTask = Object.entries(manifest.capabilities).sort((a, b) => {
    const s = (c: any) => c.speed + c.efficiency + c.coverage + c.reliability
    return s(b[1]) - s(a[1])
  })[0]?.[0]
  const strategy: ToolStrategy | null = bestTask ? selectStrategy(bestTask, { priority: 'speed' }) : null

  return { ok: true as const, manifest, bestTask, strategy, systemInstallOutput }
}

export async function uninstallTool(id: string) {
  const row = await db.installedTool.findUnique({ where: { id } })
  if (!row) return { ok: false as const, error: 'tool not installed' }
  await db.installedTool.delete({ where: { id } })
  await warmRegistry()
  await audit('tool_removed', { tool: id }, { actor: 'operator', verdict: 'allowed' })
  return { ok: true as const }
}

export async function installedTools(): Promise<ToolManifest[]> {
  const rows = await db.installedTool.findMany({ where: { enabled: true } })
  setInstalledSnapshot(rows.map((r) => ({ id: r.id, enabled: r.enabled, manifest: r.manifest })))
  return rows.map((r) => {
    try { return JSON.parse(r.manifest) as ToolManifest } catch { return null }
  }).filter((x): x is ToolManifest => !!x)
}
