// ─────────────────────────────────────────────────────────────────────────────
// Executor — the only place a composed command becomes a process.
//  • runs inside the red-team shell (WSL Kali bash / native bash / PowerShell)
//  • per-session scratch dir as working directory
//  • streams stdout/stderr live through a callback
//  • hard per-command timeout (default 90s) then kill
//  • captures output for the audit trail
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'child_process'
import { detectOS, getScratchDir } from './os'
import { trackChild, isStopRequested } from './agent/abort'
import type { ExecResult } from './types'

export interface ExecOpts {
  sessionId: string
  command: string
  timeoutMs?: number
  onChunk?: (chunk: string) => void
  env?: Record<string, string>
}

const MAX_CAPTURE = 240_000 // ~240KB of captured output per command

export async function execCommand(opts: ExecOpts): Promise<ExecResult> {
  const osInfo = detectOS()
  const scratch = getScratchDir(opts.sessionId)
  const timeoutMs = opts.timeoutMs ?? 90_000
  const started = Date.now()

  const argv =
    osInfo.exec.kind === 'wsl-bash'
      ? [...osInfo.exec.shellPrefix, 'bash', '-lc', opts.command]
      : osInfo.exec.kind === 'native-bash'
        ? [...osInfo.exec.shellPrefix, opts.command]
        : [...osInfo.exec.shellPrefix, opts.command]

  return await new Promise<ExecResult>((resolve) => {
    let output = ''
    let settled = false
    let timedOut = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: osInfo.exec.kind === 'wsl-bash' ? undefined : scratch.native,
        env: { ...process.env, ...(opts.env ?? {}), TERM: 'dumb', NO_COLOR: '1' },
        windowsHide: true,
        shell: false,
      })
      // operator interrupt (console Stop button) can kill this mid-run
      trackChild(opts.sessionId, child)
    } catch (e: any) {
      resolve({
        command: opts.command,
        exitCode: -1,
        durationMs: Date.now() - started,
        output: `spawn failed: ${e?.message ?? e}`,
        timedOut: false,
      })
      return
    }

    const killTimer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 2500)
    }, timeoutMs)

    const push = (d: Buffer) => {
      if (isStopRequested(opts.sessionId)) return
      const text = d.toString('utf8')
      if (output.length < MAX_CAPTURE) output += text
      opts.onChunk?.(text)
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      resolve({
        command: opts.command,
        exitCode: code,
        durationMs: Date.now() - started,
        output: output.length >= MAX_CAPTURE ? output + '\n[output truncated at capture limit]' : output,
        timedOut,
      })
    }
    child.on('error', (err) => {
      output += `\n[executor error] ${err.message}`
      finish(-1)
    })
    child.on('close', (code) => finish(code))
  })
}

/** Run a fixed argv list with NO shell — used by the GUARDED closed action
 *  set where injection is structurally impossible. */
export async function execArgv(
  argv: string[],
  opts: { sessionId: string; timeoutMs?: number; onChunk?: (c: string) => void; cwd?: string }
): Promise<ExecResult> {
  const scratch = getScratchDir(opts.sessionId)
  const started = Date.now()
  return await new Promise<ExecResult>((resolve) => {
    let output = ''
    let settled = false
    let timedOut = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd ?? scratch.native,
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
        windowsHide: true,
        shell: false,
      })
      // operator interrupt (console Stop button) can kill this mid-run
      trackChild(opts.sessionId, child)
    } catch (e: any) {
      resolve({ command: argv.join(' '), exitCode: -1, durationMs: 0, output: `spawn failed: ${e?.message ?? e}`, timedOut: false })
      return
    }
    const killTimer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* noop */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* noop */ } }, 2500)
    }, opts.timeoutMs ?? 60_000)
    const push = (d: Buffer) => {
      if (isStopRequested(opts.sessionId)) return
      const t = d.toString('utf8')
      if (output.length < MAX_CAPTURE) output += t
      opts.onChunk?.(t)
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      resolve({ command: argv.join(' '), exitCode: code, durationMs: Date.now() - started, output, timedOut })
    }
    child.on('error', (err) => { output += `\n[executor error] ${err.message}`; finish(-1) })
    child.on('close', (code) => finish(code))
  })
}
