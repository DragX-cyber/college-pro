// ─────────────────────────────────────────────────────────────────────────────
// REDLINE agent service — socket.io mini-service (port 3003).
// Owns everything that streams or broadcasts: the chat agent loop, approval
// decisions, mode switches, kill switch, marketplace installs, engagement
// runs, and the live audit feed. The Next.js app talks to it through the
// gateway: io("/?XTransformPort=3003").
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'http'
import { Server, type Socket } from 'socket.io'
import { randomUUID } from 'crypto'

import { db } from '../../src/core/db'
import { audit, setAuditSink } from '../../src/core/audit'
import { getSettings, setSettings, setKillSwitch } from '../../src/core/settings'
import { resolveApproval, listPendingApprovals, flushSessionGuards } from '../../src/core/guards'
import { runTurn } from '../../src/core/agent/orchestrator'
import { requestStop, requestGlobalKill, clearGlobalKill, isKillSwitchEngaged, setGlobalKill } from '../../src/core/agent/abort'
import { installTool, uninstallTool } from '../../src/core/marketplace/manager'
import { autodetectTools } from '../../src/core/marketplace/autodetect'
import { seedKnowledge } from '../../src/core/knowledge'
import { reindexKnowledge } from '../../src/core/knowledge-embed'
import { selectStrategy } from '../../src/core/tools/selector'
import { warmRegistry } from '../../src/core/tools/registry'
import { detectOS } from '../../src/core/os'
import { loadCharter, charterSummary } from '../../src/core/charter'
import { createEngagement, runEngagement, stopEngagement, stopAllEngagements, generateReport, isEngagementRunning } from '../../src/core/redteam/engines'
import type { AgentEvent, Mode } from '../../src/core/types'

const activeSessions = new Set<string>()

const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 10_000_000,
})

// every audit write is broadcast live to the Audit page
setAuditSink((event) => {
  try { io.emit('audit:event', event) } catch { /* never break the pipeline */ }
})

async function boot() {
  const initSettings = await getSettings().catch(() => null)
  if (initSettings?.killSwitch) setGlobalKill(true)
  await warmRegistry().catch(() => {})
  // Knowledge RAG: ensure the curated seed pack exists (skips if already seeded).
  try {
    const s = await seedKnowledge()
    if (!s.skipped) console.log(`[redline-agent-service] knowledge base seeded: ${s.inserted} entries`)
  } catch (e) {
    console.log(`[redline-agent-service] knowledge seed skipped: ${e instanceof Error ? e.message : String(e)}`)
  }
  // Auto-detect: scan the red-team shell for every catalog tool and register
  // what's installed — the agent's board is correct without operator clicks.
  // Detection is `which` only (no tool is executed), runs once per boot.
  try {
    const r = await autodetectTools()
    console.log(
      `[redline-agent-service] tool autodetect: ${r.available.length}/${r.scanned} found` +
        (r.registered.length ? `, newly registered: ${r.registered.join(', ')}` : ' (board up to date)')
    )
  } catch (e) {
    console.log(`[redline-agent-service] tool autodetect skipped: ${e instanceof Error ? e.message : String(e)}`)
  }
  // Vector RAG: index any knowledge entries still missing embeddings (skips
  // silently when no embedding server is configured/reachable).
  try {
    const r = await reindexKnowledge()
    if (r.indexed) console.log(`[redline-agent-service] knowledge embeddings: +${r.indexed} (${r.total} entries)`)
  } catch { /* embedder unavailable — keyword search carries the base */ }
}
void boot()

io.on('connection', (socket: Socket) => {
  // ── chat (the FREE TERMINAL / GUARDED agent loop) ──
  socket.on('session:join', async ({ sessionId }: { sessionId: string }) => {
    if (!sessionId) return
    socket.join(`session:${sessionId}`)
    let session = await db.chatSession.findUnique({ where: { id: sessionId } })
    if (!session) {
      const s = await getSettings()
      session = await db.chatSession.create({
        data: { id: sessionId, title: 'operator session', mode: s.mode },
      })
    }
    socket.emit('session:info', { sessionId, mode: session.mode })
  })

  socket.on('chat:send', async ({ sessionId, text, engagementId }: { sessionId: string; text: string; engagementId?: number }) => {
    if (!sessionId || !text?.trim()) return
    const s = await getSettings()
    if (s.killSwitch || isKillSwitchEngaged()) {
      const refusal = {
        ok: false,
        kind: 'kill_switch',
        reason: 'KILL SWITCH is ON — every action is refused until the operator clears it',
        fix: 'Clear the kill switch in the sidebar or via /kill in the CLI',
        auditKind: 'kill_switch',
        verdict: 'blocked',
      }
      io.to(`session:${sessionId}`).emit('chat:event', { type: 'guard', refusal })
      io.emit('feed:event', { sessionId, event: { type: 'guard', refusal } as any })
      io.to(`session:${sessionId}`).emit('chat:event', { type: 'final', text: '🛑 **KILL SWITCH IS ENGAGED**: Operations are suspended. Clear the kill switch in the sidebar to resume.' })
      io.emit('feed:event', { sessionId, event: { type: 'final', text: '🛑 **KILL SWITCH IS ENGAGED**: Operations are suspended. Clear the kill switch in the sidebar to resume.' } as any })
      io.to(`session:${sessionId}`).emit('chat:event', { type: 'agent_end', turnId: 'kill-switch', steps: 0 })
      io.emit('feed:event', { sessionId, event: { type: 'agent_end', turnId: 'kill-switch', steps: 0 } as any })
      return
    }

    activeSessions.add(sessionId)
    socket.join(`session:${sessionId}`)
    let session = await db.chatSession.findUnique({ where: { id: sessionId } })
    if (!session) {
      session = await db.chatSession.create({ data: { id: sessionId, title: text.slice(0, 40), mode: s.mode } })
    }
    const engagement = engagementId
      ? (await db.engagement.findUnique({ where: { id: engagementId } }))
      : null
    // every event goes to the session room (chat:event) AND globally
    // (feed:event) — the web app's single global listener feeds the main
    // terminal and keeps console streams alive across view switches
    const emit = async (event: AgentEvent) => {
      io.to(`session:${sessionId}`).emit('chat:event', event)
      io.emit('feed:event', { sessionId, event })
    }
    io.emit('feed:event', { sessionId, event: { type: 'user', text: text.trim() } })
    try {
      await runTurn({
        sessionId,
        userText: text,
        emit,
        engagement: engagement ? { id: engagement.id, target: engagement.target } : null,
      })
    } catch (e: any) {
      await emit({ type: 'error', message: `agent loop crashed: ${e?.message ?? e}` })
      await emit({ type: 'agent_end', turnId: 'crash', steps: 0 })
    } finally {
      activeSessions.delete(sessionId)
    }
  })

  // ── operator interrupt (console Stop button) ──
  // Flags the turn loop (checked between steps) AND kills any in-flight
  // command processes for the session right away. The orchestrator then ends
  // the turn through the normal teardown: progress summary, history save,
  // final + agent_end → the UI unlocks and a new prompt can be sent.
  socket.on('chat:stop', ({ sessionId }: { sessionId: string }) => {
    if (!sessionId) return
    requestStop(sessionId)
    io.emit('feed:event', { sessionId, event: { type: 'stop_requested' } as any })
  })

  // ── approvals ──
  socket.on('approval:list', async (cb?: (rows: unknown) => void) => {
    const rows = await listPendingApprovals()
    cb?.(rows)
  })

  socket.on('approval:decide', async ({ id, decision }: { id: string; decision: 'approved' | 'denied' }) => {
    const ok = await resolveApproval(id, decision, 'operator(web)')
    if (ok) io.emit('approval:updated', { id, decision })
  })

  // ── mode switcher (UNRESTRICTED needs the red warning dialog confirm) ──
  socket.on('mode:set', async ({ mode, confirm }: { mode: Mode; confirm?: boolean }) => {
    if (!['guarded', 'free', 'unrestricted'].includes(mode)) return
    const current = await getSettings()
    if (mode === 'unrestricted' && confirm !== true) {
      socket.emit('mode:rejected', { reason: 'UNRESTRICTED requires the explicit warning-dialog confirmation' })
      return
    }
    await setSettings({ mode, ...(mode !== 'unrestricted' && current.endurance ? { endurance: false } : {}) })
    if (mode !== 'unrestricted' && current.endurance) io.emit('limits:changed', { endurance: false })
    flushSessionGuards() // cached terminal state flushed so the change is immediate
    if (mode === 'unrestricted') {
      await audit('unrestricted_enabled', {
        from: current.mode,
        note: 'charter egress + approval cards OFF — destructive block, rate limits, budgets, kill switch, audits stay ON',
      }, { actor: 'operator', mode, verdict: 'info' })
      io.emit('mode:changed', { mode })
      io.emit('safety:broadcast', {
        message: '[SAFETY] UNRESTRICTED MODE — charter egress and approval cards are OFF. Destructive-pattern block, rate limits, budgets, kill switch and the audit trail remain active.',
        at: Date.now(),
      })
    } else {
      await audit('mode_changed', { from: current.mode, to: mode }, { actor: 'operator', mode, verdict: 'info' })
      io.emit('mode:changed', { mode })
    }
  })

  // ── ENDURANCE: unrestricted-only "no time/budget limits" switch ──
  socket.on('limits:set', async ({ endurance }: { endurance: boolean }, cb?: (r: unknown) => void) => {
    const s = await getSettings()
    if (s.mode !== 'unrestricted') {
      socket.emit('mode:rejected', { reason: 'ENDURANCE is only available inside UNRESTRICTED mode' })
      cb?.({ ok: false, error: 'unrestricted only' })
      return
    }
    await setSettings({ endurance: !!endurance })
    await audit('endurance_toggled', {
      endurance: !!endurance,
      note: endurance
        ? 'limits OFF — 1000 steps · 24h turns · 1h commands · no per-minute rate cap (kill switch, destructive block, no-repeat, audits stay)'
        : 'limits back ON (steps/turn/command budgets + rate cap)',
    }, { actor: 'operator', mode: s.mode, verdict: 'info' })
    io.emit('limits:changed', { endurance: !!endurance })
    cb?.({ ok: true, endurance: !!endurance })
  })

  // ── kill switch ──
  socket.on('kill:toggle', async ({ enabled, sessionId }: { enabled: boolean; sessionId?: string }) => {
    const isEngaged = !!enabled
    await setKillSwitch(isEngaged)
    setGlobalKill(isEngaged)
    await audit('kill_switch', { enabled: isEngaged, note: isEngaged ? 'Emergency kill switch engaged — all active processes killed immediately' : 'Emergency kill switch cleared' }, { actor: 'operator', verdict: isEngaged ? 'blocked' : 'allowed' })
    io.emit('kill:changed', { enabled: isEngaged })

    if (isEngaged) {
      // 1. Immediately terminate all active child processes across all sessions
      requestGlobalKill()

      // 2. Stop all running engagements
      await stopAllEngagements().catch(() => {})

      // 3. For any active sessions or provided sessionId, alert immediately
      const sessionsToStop = new Set<string>(activeSessions)
      if (sessionId) sessionsToStop.add(sessionId)

      const refusal = {
        ok: false,
        kind: 'kill_switch',
        reason: 'EMERGENCY KILL SWITCH ENGAGED — running commands and turn terminated immediately',
        fix: 'Clear the kill switch in the sidebar to resume operations',
        auditKind: 'kill_switch',
        verdict: 'blocked',
      }

      for (const sId of Array.from(sessionsToStop)) {
        requestStop(sId)
        io.to(`session:${sId}`).emit('chat:event', { type: 'stop_requested' })
        io.emit('feed:event', { sessionId: sId, event: { type: 'stop_requested' } as any })
        io.to(`session:${sId}`).emit('chat:event', { type: 'guard', refusal })
        io.emit('feed:event', { sessionId: sId, event: { type: 'guard', refusal } as any })
      }
    } else {
      clearGlobalKill()
    }
  })

  // ── marketplace ──
  socket.on('market:install', async ({ id, systemInstall }: { id: string; systemInstall?: boolean }, cb?: (r: unknown) => void) => {
    const r = await installTool(id, { systemInstall })
    if (r.ok) {
      io.emit('tool:registered', {
        id: r.manifest.id,
        name: r.manifest.name,
        purpose: r.manifest.purpose,
        usage: r.manifest.usage,
        bestTask: r.bestTask,
        strategy: r.strategy,
        note: `The agent now knows ${r.manifest.name}: its purpose, usage, capability scores, pros and flaws are on its tool board from the next action.`,
      })
    }
    cb?.(r)
  })

  socket.on('market:uninstall', async ({ id }: { id: string }, cb?: (r: unknown) => void) => {
    const r = await uninstallTool(id)
    if (r.ok) io.emit('tool:removed', { id })
    cb?.(r)
  })

  socket.on('tool:strategy', ({ task, priority }: { task: string; priority?: string }, cb?: (r: unknown) => void) => {
    const p = (['speed', 'coverage', 'stealth', 'reliability', 'balanced'].includes(String(priority)) ? priority : 'balanced') as any
    cb?.(selectStrategy(task, { priority: p }))
  })

  // Operator-triggered scan of the red-team shell for installed tools.
  socket.on('market:autodetect', async (_data: unknown, cb?: (r: unknown) => void) => {
    const r = await autodetectTools()
    for (const manifest of r.available) {
      if (!r.registered.includes(manifest.id)) continue
      io.emit('tool:registered', {
        id: manifest.id,
        name: manifest.name,
        purpose: manifest.purpose,
        usage: manifest.usage,
        note: `${manifest.name} was detected installed in the red-team shell and registered automatically.`,
      })
    }
    io.emit('tools:autodetected', {
      scanned: r.scanned,
      available: r.available.map((t) => t.id),
      registered: r.registered,
      missing: r.missing,
    })
    cb?.(r)
  })

  // ── engagements ──
  socket.on('engagement:create', async (input: { target: string; objective: string; profile: string; domains: string[] }, cb?: (r: unknown) => void) => {
    const s = await getSettings()
    const r = await createEngagement({
      target: input.target,
      objective: input.objective ?? 'assess the attack surface',
      profile: (['stealth', 'balanced', 'fast'].includes(input.profile) ? input.profile : 'balanced') as any,
      domains: Array.isArray(input.domains) ? input.domains : [],
      mode: s.mode,
    })
    if (r.ok) io.emit('engagement:updated', { id: r.engagement.id, eid: r.engagement.eid, status: 'planned' })
    cb?.(r)
  })

  socket.on('engagement:run', async ({ id, runner }: { id: number; runner?: 'heuristic' | 'agent' }, cb?: (r: unknown) => void) => {
    if (!id) return
    if (isEngagementRunning(id)) { cb?.({ ok: false, error: 'already running' }); return }
    io.emit('engagement:started', { id })
    // run async; events stream as chat:event on the engagement room + global
    void runEngagement(id, {
      runner: runner === 'agent' ? 'agent' : 'heuristic',
      emit: async (event) => {
        io.emit('engagement:event', { engagementId: id, event })
      },
    }).then((r) => {
      io.emit('engagement:updated', { id, status: r.ok ? 'done' : 'aborted' })
    })
    cb?.({ ok: true })
  })

  socket.on('engagement:stop', async ({ id }: { id: number }) => {
    await stopEngagement(id)
    io.emit('engagement:updated', { id, status: 'aborted' })
  })

  socket.on('engagement:report', async ({ id }: { id: number }, cb?: (r: unknown) => void) => {
    cb?.({ ok: true, report: await generateReport(id) })
  })

  // ── system intel ──
  socket.on('system:refresh', async (cb?: (r: unknown) => void) => {
    const s = await getSettings()
    const charter = loadCharter()
    const tools = (await import('../../src/core/tools/registry')).getRegistry({ resolveAvailability: true })
    cb?.({
      mode: s.mode,
      killSwitch: s.killSwitch,
      endurance: s.endurance,
      budgets: s.budgets,
      os: detectOS(),
      charter: charterSummary(),
      charterFile: charter.engagement_id,
      tools: tools.map((t) => ({ id: t.id, name: t.name, category: t.category, availability: t.availability, builtin: !!t.builtin })),
    })
  })

  socket.on('ping:ts', (data: { t?: number }, cb?: (r: unknown) => void) => {
    cb?.({ t: data?.t ?? 0, id: randomUUID() })
  })
})

const PORT = 3003
httpServer.listen(PORT, () => {
  console.log(`[redline-agent-service] socket.io listening on :${PORT}`)
})

process.on('SIGTERM', () => { httpServer.close(() => process.exit(0)) })
process.on('SIGINT', () => { httpServer.close(() => process.exit(0)) })
