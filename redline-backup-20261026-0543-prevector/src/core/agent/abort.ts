// ─────────────────────────────────────────────────────────────────────────────
// Operator interrupt — per-session STOP registry + EMERGENCY KILL SWITCH.
// The console Stop button calls requestStop(sessionId).
// The Kill Switch button calls requestGlobalKill() which forcefully terminates
// all active child processes across ALL sessions immediately.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, type ChildProcess } from 'child_process'

/** sessionId → true while a stop is pending (before the loop consumes it) */
const stopFlags = new Map<string, true>()

/** sessionId → live child processes spawned by the executor for that session */
const children = new Map<string, Set<ChildProcess>>()

/** Global kill switch state */
let globalKillEngaged = false

export function isKillSwitchEngaged(): boolean {
  return globalKillEngaged
}

export function setGlobalKill(engaged: boolean): void {
  globalKillEngaged = engaged
}

export function clearGlobalKill(): void {
  globalKillEngaged = false
}

/** Operator engaged EMERGENCY KILL SWITCH: kill everything across all sessions immediately. */
export function requestGlobalKill(): string[] {
  globalKillEngaged = true
  const affectedSessions: string[] = []
  for (const [sessionId, set] of children.entries()) {
    stopFlags.set(sessionId, true)
    affectedSessions.push(sessionId)
    for (const child of Array.from(set)) {
      killProcess(child)
    }
  }
  return affectedSessions
}

/** Operator pressed STOP: flag the turn loop and kill anything running now. */
export function requestStop(sessionId: string): void {
  stopFlags.set(sessionId, true)
  for (const child of Array.from(children.get(sessionId) ?? [])) killProcess(child)
}

/** The turn loop consumed the stop (or a fresh turn started) — clear the flag. */
export function clearStop(sessionId: string): void {
  stopFlags.delete(sessionId)
}

/** Checked by the orchestrator and executor at safe points. */
export function isStopRequested(sessionId: string): boolean {
  return globalKillEngaged || stopFlags.has(sessionId)
}

/** Called by the executor right after spawn; auto-untracked on exit. */
export function trackChild(sessionId: string, child: ChildProcess): void {
  let set = children.get(sessionId)
  if (!set) children.set(sessionId, (set = new Set()))
  set.add(child)
  const untrack = () => { set?.delete(child) }
  child.once('close', untrack)
  child.once('error', untrack)
}

/** Forcefully terminate a child process and its process tree. */
export function killProcess(child: ChildProcess): void {
  try {
    child.stdout?.destroy()
    child.stderr?.destroy()
  } catch { /* already closed */ }

  const pid = child.pid
  if (process.platform === 'win32' && pid) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } catch { /* taskkill fallback */ }
  }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
  try { child.kill('SIGTERM') } catch { /* already gone */ }
}
