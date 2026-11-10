// ─────────────────────────────────────────────────────────────────────────────
// OS awareness — the agent is told exactly what system it runs on and which
// shell executes its commands:
//   • Windows + WSL (Kali preferred)  → commands run inside WSL bash
//   • Linux / macOS                    → native bash
//   • Windows without WSL              → PowerShell fallback
// Every session gets its own scratch dir under .redline/scratch/.
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import os from 'os'
import path from 'path'
import { SCRATCH_ROOT } from './paths'
import type { OSInfo } from './types'

let cachedOS: { at: number; info: OSInfo } | null = null
const OS_TTL_MS = 30_000

function run(cmd: string, args: string[], timeoutMs = 6000): string | null {
  try {
    const r = spawnSync(cmd, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true })
    if (r.error || r.status !== 0) return null
    return (r.stdout || '') + (r.stderr || '')
  } catch {
    return null
  }
}

/** Windows path → POSIX path as seen from inside WSL (/mnt/c/...). */
export function winToPosix(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const m = norm.match(/^([A-Za-z]):\/(.*)$/)
  if (!m) return norm
  return `/mnt/${m[1].toLowerCase()}/${m[2]}`
}

function detectWsl(): { available: boolean; distros: string[]; preferred: string | null; kaliPresent: boolean } {
  if (process.platform !== 'win32') return { available: false, distros: [], preferred: null, kaliPresent: false }
  // wsl.exe prints UTF-16LE on modern Windows — handle both encodings.
  let out = run('wsl.exe', ['-l', '-q'], 8000)
  if (out == null) out = run('wsl', ['-l', '-q'], 8000)
  if (out == null) return { available: false, distros: [], preferred: null, kaliPresent: false }
  const text = out.replace(/\u0000/g, '')
  const distros = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Windows Subsystem/i.test(l) && !/^NAME$/i.test(l))
  const kali = distros.find((d) => /kali/i.test(d))
  return {
    available: distros.length > 0,
    distros,
    preferred: kali ?? distros[0] ?? null,
    kaliPresent: Boolean(kali),
  }
}

export function detectOS(): OSInfo {
  if (cachedOS && Date.now() - cachedOS.at < OS_TTL_MS) return cachedOS.info

  const isWindows = process.platform === 'win32'
  const wsl = detectWsl()
  const user = (() => { try { return os.userInfo().username } catch { return 'operator' } })()

  let exec: OSInfo['exec']
  if (isWindows && wsl.preferred) {
    const scratchPosix = winToPosix(path.join(process.env.TEMP || 'C:\\temp', 'redline', 'scratch'))
    exec = {
      kind: 'wsl-bash',
      shellPrefix: ['wsl', '-d', wsl.preferred, '--cd', scratchPosix],
      scratchRoot: scratchPosix,
      note: `commands execute inside WSL (${wsl.preferred}) bash, per-session scratch dir, streamed + audited`,
    }
  } else if (isWindows) {
    const scratchWin = path.join(process.env.TEMP || 'C:\\temp', 'redline', 'scratch')
    exec = {
      kind: 'powershell',
      shellPrefix: ['powershell', '-NoProfile', '-Command'],
      scratchRoot: scratchWin.replace(/\\/g, '\\'),
      note: 'no WSL distro detected — commands run in PowerShell (install WSL Kali for the full red-team toolchain)',
    }
  } else {
    exec = {
      kind: 'native-bash',
      shellPrefix: ['bash', '-lc'],
      scratchRoot: SCRATCH_ROOT,
      note: 'commands execute in native bash, per-session scratch dir, streamed + audited',
    }
  }

  const info: OSInfo = {
    platform: process.platform,
    isWindows,
    isLinux: process.platform === 'linux',
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    user,
    wsl,
    exec,
  }
  cachedOS = { at: Date.now(), info }
  return info
}

/** Invalidate the OS cache (e.g. after installing WSL tools). */
export function invalidateOSCache() {
  cachedOS = null
}

/** Per-session scratch dir. Returns {native, posix} — posix is what the
 *  red-team shell sees (WSL mounts the same dir under /mnt/...). */
export function getScratchDir(sessionId: string): { native: string; posix: string } {
  const osInfo = detectOS()
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'default'
  if (osInfo.isWindows && osInfo.exec.kind === 'wsl-bash') {
    const posix = path.posix.join(osInfo.exec.scratchRoot, safe)
    // create from the Windows side so WSL can see it through the mount
    const winRoot = process.env.TEMP || 'C:\\temp'
    const winPath = path.join(winRoot, 'redline', 'scratch', safe)
    try { mkdirSync(winPath, { recursive: true }) } catch { /* best effort */ }
    return { native: winPath, posix }
  }
  const native = path.join(SCRATCH_ROOT, safe)
  try { mkdirSync(native, { recursive: true }) } catch { /* best effort */ }
  return { native, posix: native }
}

const whichCache = new Map<string, { at: number; found: boolean }>()
const WHICH_TTL_MS = 60_000

/** Is a binary available inside the red-team shell? (cached 60s) */
export function whichBin(bin: string): boolean {
  const key = `${detectOS().exec.kind}:${bin}`
  const hit = whichCache.get(key)
  if (hit && Date.now() - hit.at < WHICH_TTL_MS) return hit.found
  const osInfo = detectOS()
  let found = false
  if (osInfo.exec.kind === 'wsl-bash') {
    const r = run('wsl', ['-d', osInfo.wsl.preferred ?? '', '--', 'which', bin], 8000)
    found = !!(r && r.trim().length > 0)
  } else if (osInfo.exec.kind === 'native-bash') {
    const r = run('which', [bin], 5000)
    found = !!(r && r.trim().length > 0)
  } else {
    const r = run('where', [bin], 5000)
    found = !!(r && r.trim().length > 0)
  }
  whichCache.set(key, { at: Date.now(), found })
  return found
}

export function invalidateWhichCache() {
  whichCache.clear()
}
