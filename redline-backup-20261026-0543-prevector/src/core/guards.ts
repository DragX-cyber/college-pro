// ─────────────────────────────────────────────────────────────────────────────
// Guards — the deterministic layer BELOW the AI.
//
// FREE TERMINAL pipeline (in order):
//   1. kill switch
//   2. destructive-pattern block (no off switch — protects your machine)
//   3. charter egress — every host in the command must pass resolveTarget;
//      files/binaries excluded; an unchartered host refuses the whole command
//      and names the fix. The agent cannot widen scope itself.
//      (skipped in UNRESTRICTED)
//   4. classification — recognizably read-only runs immediately, everything
//      else raises an approval card showing the exact command.
//      (approval cards skipped in UNRESTRICTED)
//   5. rate limit + budgets + no-repeat guard
// ─────────────────────────────────────────────────────────────────────────────
import { db } from './db'
import { audit } from './audit'
import { loadCharter, resolveTarget } from './charter'
import { getSettings } from './settings'
import { isKillSwitchEngaged } from './agent/abort'
import { hostsIn, matchDestructive } from './guardPatterns'
import ipaddr from 'ipaddr.js'
import type { Charter, GuardRefusal, Mode } from './types'

// ─── kill switch ─────────────────────────────────────────────────────────────

export async function checkKillSwitch(): Promise<GuardRefusal | null> {
  const s = await getSettings()
  if (s.killSwitch || isKillSwitchEngaged()) {
    return {
      ok: false,
      kind: 'kill_switch',
      reason: 'KILL SWITCH is ON — every action is refused until the operator clears it',
      fix: 'Clear the kill switch in the sidebar or via /kill in the CLI',
      auditKind: 'kill_switch',
      verdict: 'blocked',
    }
  }
  return null
}

// ─── rate limiting (charter rules_of_engagement) ─────────────────────────────

const actionTimes: number[] = []

export function checkRateLimit(charter: Charter): GuardRefusal | null {
  const limit = charter.rules_of_engagement.rate_limit_per_minute ?? 30
  const now = Date.now()
  while (actionTimes.length && now - actionTimes[0] > 60_000) actionTimes.shift()
  if (actionTimes.length >= limit) {
    return {
      ok: false,
      kind: 'rate_limited',
      reason: `rate limit reached — charter allows at most ${limit} actions/minute (this survives UNRESTRICTED)`,
      auditKind: 'rate_limited',
      verdict: 'refused',
    }
  }
  return null
}

export function recordAction() {
  // one action per runTool call — a shell_batch of N commands records N
  // actions via its N runTool calls. Concurrent batch members can pass
  // checkRateLimit before any records (TOCTOU): overshoot is bounded by the
  // batch size and accepted — the limiter throttles sustained rate, not ticks.
  actionTimes.push(Date.now())
}

// ─── no-repeat guard (loop detection) ────────────────────────────────────────

interface RecentCommand { cmd: string; at: number }
const recentBySession = new Map<string, RecentCommand[]>()

export function normalizeCommand(cmd: string): string {
  return cmd.replace(/\s+/g, ' ').trim()
}

export function checkNoRepeat(sessionId: string, command: string): GuardRefusal | null {
  const list = recentBySession.get(sessionId) ?? []
  const now = Date.now()
  const norm = normalizeCommand(command)
  const recent = list.filter((r) => now - r.at < 180_000)
  const identical = recent.filter((r) => r.cmd === norm)
  if (identical.length >= 2) {
    return {
      ok: false,
      kind: 'loop_blocked',
      reason: 'no-repeat guard: this exact command already ran twice in the last 3 minutes — change approach instead of looping',
      fix: 'Vary the command, adjust flags, or state your conclusion and finish',
      auditKind: 'loop_blocked',
      verdict: 'refused',
    }
  }
  return null
}

export function recordCommand(sessionId: string, command: string) {
  const list = recentBySession.get(sessionId) ?? []
  list.push({ cmd: normalizeCommand(command), at: Date.now() })
  recentBySession.set(sessionId, list.slice(-30))
}

/** Flush per-session state (e.g. on mode switch so the change is immediate). */
export function flushSessionGuards() {
  recentBySession.clear()
}

// ─── destructive-pattern block (no off switch) ───────────────────────────────

export function checkDestructive(command: string): GuardRefusal | null {
  const m = matchDestructive(command)
  if (!m) return null
  return {
    ok: false,
    kind: 'destructive_block',
    reason: `destructive pattern blocked (${m.pattern}): ${m.reason}. This block has NO off switch — it protects the operator's machine, not targets, and stays on in every mode.`,
    auditKind: 'command_blocked',
    verdict: 'blocked',
  }
}

// ─── charter egress (the free-terminal layer-3 check) ────────────────────────

/** A CIDR the agent mentioned is allowed iff it sits fully inside one
 *  chartered network (a /24 sweep needs a chartered /24-or-wider supernet). */
function cidrWithinCharter(charter: Charter, cidr: string): boolean {
  try {
    const [addr, prefix] = ipaddr.parseCIDR(cidr)
    for (const net of charter.scope.networks) {
      try {
        const [netAddr, netPrefix] = ipaddr.parseCIDR(net.trim())
        if (netAddr.kind() !== addr.kind()) continue
        if (prefix >= netPrefix && addr.match([netAddr, netPrefix])) return true
      } catch { /* malformed network entry — skip, never widen */ }
    }
  } catch { /* malformed cidr — refuse by returning false */ }
  return false
}

export async function checkEgress(
  command: string,
  mode: Mode,
  opts: { engagementTarget?: string } = {}
): Promise<GuardRefusal | null> {
  if (mode === 'unrestricted') return null // explicit, warned override
  const charter = loadCharter() // fresh for every action
  const hosts = hostsIn(command)
  for (const host of hosts) {
    // Engine layer: one-engagement-one-target
    if (opts.engagementTarget) {
      const hostNorm = host.toLowerCase()
      const targetNorm = opts.engagementTarget.toLowerCase()
      if (hostNorm !== targetNorm && hostNorm !== 'localhost' && targetNorm !== 'localhost') {
        // localhost == the machine itself, always allowed
        const sameMachine = hostNorm === 'localhost' || hostNorm === '127.0.0.1' || hostNorm === '::1'
        if (!sameMachine) {
          return {
            ok: false,
            kind: 'off_target_refused',
            reason: `host "${host}" is not this engagement's target — this engagement is for ${opts.engagementTarget} (being in the charter is permission to touch; the plan decides what this engagement is for)`,
            fix: `Work only against ${opts.engagementTarget}, or ask the operator to start a separate engagement`,
            auditKind: 'off_target_refused',
            verdict: 'refused',
          }
        }
      }
    }
    // CIDR form → network-containment check
    if (/\/\d{1,3}$/.test(host)) {
      if (cidrWithinCharter(charter, host)) continue
      return {
        ok: false,
        kind: 'free_command_refused',
        reason: `network "${host}" is not inside any chartered network — one unchartered range refuses the whole command.`,
        fix: `python charter_add.py add ${host} --detect or widen scope.networks in lab/charter.yaml`,
        auditKind: 'free_command_refused',
        verdict: 'refused',
      }
    }
    const res = await resolveTarget(charter, host)
    if (!res.ok) {
      return {
        ok: false,
        kind: 'free_command_refused',
        reason: `host "${host}" failed the charter check: ${res.reason}. One unchartered host refuses the whole command.`,
        fix: res.fix ?? `python charter_add.py add ${host} --detect`,
        auditKind: 'free_command_refused',
        verdict: 'refused',
      }
    }
  }
  return null
}

// ─── approval seat ───────────────────────────────────────────────────────────

type ApprovalDecision = 'approved' | 'denied' | 'expired'

const pending = new Map<string, { resolve: (d: ApprovalDecision) => void; timer: NodeJS.Timeout }>()

export async function createApproval(input: {
  tool: string
  command: string
  reason: string
  mode: Mode
  sessionId?: string
  engagementId?: number
}): Promise<string> {
  const row = await db.approvalRequest.create({
    data: {
      tool: input.tool,
      command: input.command,
      reason: input.reason,
      mode: input.mode,
      sessionId: input.sessionId,
      // ApprovalRequest.engagementId is a String column; Engagement.id is Int.
      engagementId: input.engagementId != null ? String(input.engagementId) : undefined,
      status: 'pending',
    },
  })
  return row.id
}

/** Wait until the operator decides (or the card expires). */
export function awaitApproval(id: string, timeoutMs = 180_000): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      db.approvalRequest.update({ where: { id }, data: { status: 'expired', decidedAt: new Date(), decidedBy: 'timeout' } }).catch(() => {})
      resolve('expired')
    }, timeoutMs)
    pending.set(id, {
      resolve: (d) => {
        clearTimeout(timer)
        resolve(d)
      },
      timer,
    })
  })
}

/** Operator decision arrives from the web console or the CLI. */
export async function resolveApproval(id: string, decision: 'approved' | 'denied', by = 'operator'): Promise<boolean> {
  const row = await db.approvalRequest.findUnique({ where: { id } })
  if (!row || row.status !== 'pending') return false
  await db.approvalRequest.update({
    where: { id },
    data: { status: decision, decidedAt: new Date(), decidedBy: by },
  })
  pending.get(id)?.resolve(decision)
  pending.delete(id)
  await audit(decision === 'approved' ? 'command_approved' : 'command_denied', {
    approvalId: id,
    command: row.command,
    tool: row.tool,
  }, { actor: 'operator', mode: row.mode, verdict: decision === 'approved' ? 'allowed' : 'refused' })
  return true
}

export async function listPendingApprovals() {
  return db.approvalRequest.findMany({ where: { status: 'pending' }, orderBy: { id: 'desc' } })
}
