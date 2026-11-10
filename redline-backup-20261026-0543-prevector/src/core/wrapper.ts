// ─────────────────────────────────────────────────────────────────────────────
// Wrapper — the five-step sequence every real tool goes through (tool layer).
// This is the ONLY code path that executes any tool:
//   1. scope check      — resolveTarget against a freshly loaded charter
//   2. rate limit       — charter rules_of_engagement
//   3. policy validate  — destructive block (always), classification,
//                         approval seat when required
//   4. execute          — streamed inside the red-team shell, per-session
//                         scratch dir, hard per-command timeout
//   5. capture + audit  — full text, exit code, duration, verdict
// GUARDED's closed action set runs through here too, with fixed argv lists
// and shell:false — injection is structurally impossible.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from './db'
import { audit } from './audit'
import { loadCharter, resolveTarget, normalizeHost } from './charter'
import { getSettings } from './settings'
import { detectOS } from './os'
import { isKillSwitchEngaged, isStopRequested } from './agent/abort'
import { execArgv, execCommand } from './executor'
import {
  checkKillSwitch, checkRateLimit, checkDestructive, checkEgress, checkNoRepeat,
  recordAction, recordCommand, createApproval, awaitApproval,
} from './guards'
import { classifyCommand } from './guardPatterns'
import type { EmitFn, ExecResult, GuardRefusal, Mode } from './types'

export interface RunToolInput {
  sessionId: string
  tool: string
  /** display label, e.g. "nmap ▸ port sweep" */
  label: string
  /** composed shell command (FREE / UNRESTRICTED / engagement runner) */
  command?: string
  /** fixed argv (GUARDED closed set) — executed with shell:false */
  argv?: string[]
  /** primary target for the tool-layer scope check */
  targetHost?: string
  mode: Mode
  engagementId?: number
  engagementTarget?: string
  timeoutMs?: number
  /** closed set is read-only by construction */
  readonlyByConstruction?: boolean
  emit: EmitFn
}

export type RunToolOutcome = { ok: true; result: ExecResult } | GuardRefusal

export async function runTool(input: RunToolInput): Promise<RunToolOutcome> {
  const settings = await getSettings()

  // ── step 0: kill switch (every mode) ──
  const kill = await checkKillSwitch()
  if (kill) {
    await audit(kill.auditKind, { tool: input.tool, label: input.label, reason: kill.reason }, { mode: input.mode, actor: 'agent', verdict: 'blocked' })
    return kill
  }

  // ── step 1: scope check (always, tool layer) ──
  if (input.targetHost && input.mode !== 'unrestricted') {
    const charter = loadCharter() // fresh
    const res = await resolveTarget(charter, input.targetHost)
    if (!res.ok) {
      const refusal: GuardRefusal = {
        ok: false, kind: 'scope_refused',
        reason: `scope refused: ${res.reason}`,
        fix: res.fix,
        auditKind: 'scope_refused', verdict: 'refused',
      }
      await audit('scope_refused', { tool: input.tool, target: input.targetHost, reason: res.reason }, { mode: input.mode, actor: 'agent', verdict: 'refused' })
      return refusal
    }
  }

  // free-terminal egress check (layer 3): every host in a composed command
  if (input.command) {
    const egress = await checkEgress(input.command, input.mode, { engagementTarget: input.engagementTarget })
    if (egress) {
      await audit(egress.auditKind, { tool: input.tool, command: input.command, reason: egress.reason }, { mode: input.mode, actor: 'agent', verdict: 'refused' })
      return egress
    }
  }

  // ── step 2: rate limit (a time guard — lifted by ENDURANCE in unrestricted) ──
  const endurance = settings.mode === 'unrestricted' && settings.endurance
  const charter2 = loadCharter()
  const rl = endurance ? null : checkRateLimit(charter2)
  if (rl) {
    await audit(rl.auditKind, { tool: input.tool, command: input.command ?? input.argv?.join(' ') }, { mode: input.mode, actor: 'agent', verdict: 'refused' })
    return rl
  }
  recordAction()

  // ── step 3: policy validate ──
  // 3a. destructive-pattern block — always on, no off switch
  if (input.command) {
    const destr = checkDestructive(input.command)
    if (destr) {
      await audit(destr.auditKind, { tool: input.tool, command: input.command, pattern: destr.reason }, { mode: input.mode, actor: 'agent', verdict: 'blocked' })
      return destr
    }
    // 3b. no-repeat guard
    const repeat = checkNoRepeat(input.sessionId, input.command)
    if (repeat) {
      await audit(repeat.auditKind, { tool: input.tool, command: input.command }, { mode: input.mode, actor: 'agent', verdict: 'refused' })
      return repeat
    }
    recordCommand(input.sessionId, input.command)
  }

  // 3c. classification — read-only runs immediately, everything else waits
  let needsApproval = false
  let approvalReason = ''
  if (input.readonlyByConstruction) {
    needsApproval = false
  } else if (input.command) {
    const cls = classifyCommand(input.command)
    if (cls.kind === 'blocked') {
      const refusal: GuardRefusal = { ok: false, kind: 'destructive_block', reason: `${cls.reason} (classification)`, auditKind: 'command_blocked', verdict: 'blocked' }
      await audit('command_blocked', { tool: input.tool, command: input.command, reason: cls.reason }, { mode: input.mode, actor: 'agent', verdict: 'blocked' })
      return refusal
    }
    if (cls.kind === 'approval') {
      // UNRESTRICTED: no approval cards — nothing waits for you
      if (input.mode === 'unrestricted' || settings.autoApproveNonReadOnly && input.mode === 'free') {
        needsApproval = false
      } else {
        needsApproval = true
        approvalReason = cls.reason
      }
    }
  }

  if (needsApproval) {
    const id = await createApproval({
      tool: input.tool,
      command: input.command ?? input.argv?.join(' ') ?? input.label,
      reason: approvalReason,
      mode: input.mode,
      sessionId: input.sessionId,
      engagementId: input.engagementId,
    })
    await input.emit({
      type: 'approval_required',
      approval: { id, tool: input.tool, command: input.command ?? '', reason: approvalReason, mode: input.mode },
    })
    const decision = await awaitApproval(id)
    await input.emit({ type: 'approval_resolved', id, decision })
    if (decision !== 'approved') {
      const refusal: GuardRefusal = {
        ok: false,
        kind: decision === 'expired' ? 'approval_timeout' : 'approval_denied',
        reason: decision === 'expired'
          ? 'approval card expired (180s) — the command never ran'
          : 'operator denied this command — it never ran',
        auditKind: decision === 'expired' ? 'approval_timeout' : 'approval_denied',
        verdict: 'refused',
      }
      await audit('command_denied', { approvalId: id, command: input.command }, { mode: input.mode, actor: 'operator', verdict: 'refused' })
      return refusal
    }
  }

  // ── step 4: execute (streamed) ──
  // ENDURANCE default: 1h per command instead of the budgets.commandSeconds cap
  const timeoutMs = input.timeoutMs ?? (settings.mode === 'unrestricted' && settings.endurance ? 3_600_000 : settings.budgets.commandSeconds * 1000)
  const runRow = await db.toolRun.create({
    data: {
      tool: input.tool,
      args: input.command ?? input.argv?.join(' ') ?? input.label,
      target: input.targetHost ?? null,
      mode: input.mode,
      verdict: 'running',
      sessionId: input.sessionId,
    },
  })
  await input.emit({ type: 'output_start', runId: runRow.id, label: input.label })

  let result: ExecResult
  if (input.argv) {
    result = await execArgv(input.argv, {
      sessionId: input.sessionId,
      timeoutMs,
      onChunk: (chunk) => { void input.emit({ type: 'output', runId: runRow.id, chunk }) },
    })
  } else {
    result = await execCommand({
      sessionId: input.sessionId,
      command: input.command ?? '',
      timeoutMs,
      onChunk: (chunk) => { void input.emit({ type: 'output', runId: runRow.id, chunk }) },
    })
  }

  // ── step 5: capture + audit ──
  const isKilled = (await getSettings()).killSwitch || isKillSwitchEngaged()
  const isStopped = isStopRequested(input.sessionId)
  const outputHead = result.output.slice(0, 4000)
  const verdict = isKilled ? 'killed' : isStopped ? 'interrupted' : result.timedOut ? 'timeout' : 'executed'
  await db.toolRun.update({
    where: { id: runRow.id },
    data: {
      verdict,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputHead,
    },
  })
  await input.emit({
    type: 'output_end',
    runId: runRow.id,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    verdict,
  })
  await audit('command_executed', {
    tool: input.tool,
    command: input.command ?? input.argv?.join(' '),
    target: input.targetHost,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    outputHead: outputHead.slice(0, 600),
  }, { mode: input.mode, actor: 'agent', verdict: isKilled ? 'blocked' : 'allowed' })

  if (isKilled) {
    const killRefusal: GuardRefusal = {
      ok: false,
      kind: 'kill_switch',
      reason: 'Emergency kill switch engaged by operator — command was killed mid-run',
      fix: 'Clear the kill switch in the sidebar to resume operations',
      auditKind: 'kill_switch',
      verdict: 'blocked',
    }
    await audit('kill_switch', { tool: input.tool, command: input.command, reason: killRefusal.reason }, { mode: input.mode, actor: 'agent', verdict: 'blocked' })
    return killRefusal
  }

  return { ok: true, result }
}

// ─── GUARDED closed action set ───────────────────────────────────────────────
// The model never writes commands here. It picks from a closed action set
// where every argument is built by hardcoded code — fixed argv lists with no
// shell, so injection is structurally impossible. Exactly four read-only
// checks: ping, nslookup, whatweb, curl.

export type GuardedCheck = 'ping' | 'nslookup' | 'whatweb' | 'curl'

export function guardedArgv(check: GuardedCheck, target: string): { argv: string[]; label: string } | { error: string } {
  const host = normalizeHost(target)
  if (!host) return { error: `"${target}" is not a valid host or URL` }
  const osInfo = detectOS()
  const isWin = osInfo.isWindows && osInfo.exec.kind === 'powershell'
  switch (check) {
    case 'ping':
      return {
        argv: isWin ? ['ping', '-n', '4', '-w', '8000', host] : ['ping', '-c', '4', '-w', '8', host],
        label: `ping ▸ ${host}`,
      }
    case 'nslookup':
      return { argv: ['nslookup', host], label: `nslookup ▸ ${host}` }
    case 'whatweb': {
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${host}/`
      return { argv: ['whatweb', '--color=never', '--no-errors', url], label: `whatweb ▸ ${url}` }
    }
    case 'curl': {
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${host}/`
      return {
        argv: ['curl', '-sS', '--max-time', '20', '-L', '-w', '\n[http_code=%{http_code} size=%{size_download}]', url],
        label: `curl ▸ ${url}`,
      }
    }
  }
}

export async function runGuardedCheck(
  check: GuardedCheck,
  target: string,
  ctx: { sessionId: string; mode: Mode; emit: EmitFn; engagementTarget?: string }
): Promise<RunToolOutcome> {
  const built = guardedArgv(check, target)
  if ('error' in built) {
    return { ok: false, kind: 'parse_error', reason: built.error, auditKind: 'parse_error', verdict: 'refused' } as GuardRefusal
  }
  const settings = await getSettings()
  // GUARDED approval seat: in GUARDED mode every closed-set action waits for
  // the operator (unless they trusted the deterministic set). In FREE /
  // UNRESTRICTED the closed set is read-only by construction and runs
  // immediately — the seat is a GUARDED-mode feature.
  if (ctx.mode === 'guarded' && !settings.autoApproveClosedSet) {
    const id = await createApproval({
      tool: `run_check:${check}`,
      command: built.argv.join(' '),
      reason: 'GUARDED approval seat — closed action set, fixed argv, no shell',
      mode: ctx.mode,
      sessionId: ctx.sessionId,
    })
    await ctx.emit({
      type: 'approval_required',
      approval: { id, tool: `run_check:${check}`, command: built.argv.join(' '), reason: 'GUARDED approval seat (closed set, fixed argv, no shell)', mode: ctx.mode },
    })
    const decision = await awaitApproval(id)
    await ctx.emit({ type: 'approval_resolved', id, decision })
    if (decision !== 'approved') {
      return {
        ok: false,
        kind: decision === 'expired' ? 'approval_timeout' : 'approval_denied',
        reason: decision === 'expired' ? 'approval card expired — the check never ran' : 'operator denied this check',
        auditKind: decision === 'expired' ? 'approval_timeout' : 'command_denied',
        verdict: 'refused',
      }
    }
  }
  return runTool({
    sessionId: ctx.sessionId,
    tool: `run_check:${check}`,
    label: built.label,
    argv: built.argv,
    targetHost: target,
    mode: ctx.mode,
    engagementTarget: ctx.engagementTarget,
    readonlyByConstruction: true,
    emit: ctx.emit,
  })
}
