// Project path resolution that works from every entrypoint:
// Next.js dev server (cwd = repo root), the socket mini-service
// (cwd = mini-services/agent-service), and the CLI (cwd = repo root).
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

function findRoot(): string {
  const anchors: string[] = []
  try {
    // src/core/paths.ts → walk up 2 levels (src/core → src → repo root)
    anchors.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
  } catch {
    /* bundlers without import.meta.url — fall through */
  }
  if (process.cwd()) anchors.push(process.cwd())

  for (const start of anchors) {
    let dir = path.resolve(start)
    for (let i = 0; i < 8; i++) {
      if (existsSync(path.join(dir, 'prisma', 'schema.prisma'))) return dir
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  // Last resort: wherever the process was launched from.
  return process.cwd() || process.env.HOME || '.'
}

export const ROOT = findRoot()
export const LAB_DIR = path.join(ROOT, 'lab')
export const CHARTER_PATH = path.join(LAB_DIR, 'charter.yaml')
export const DATA_DIR = path.join(ROOT, '.redline')
export const SCRATCH_ROOT = path.join(DATA_DIR, 'scratch')
