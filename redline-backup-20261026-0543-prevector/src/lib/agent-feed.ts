'use client'
// ─────────────────────────────────────────────────────────────────────────────
// Agent feed — the app-wide, view-independent capture of everything the AI
// does. ONE socket listener (installed by initFeed() from the app shell)
// routes every agent event into:
//   streams[sessionId]  — the full chat stream per session (survives view
//                         switches: the console reads it from here, so
//                         navigating away and back never loses the chat, and
//                         events keep being captured while you're elsewhere)
//   terminal            — the global "main terminal": every command, refusal,
//                         approval, finding and final across all sessions
// ─────────────────────────────────────────────────────────────────────────────
import { create } from 'zustand'
import { getSocket } from '@/lib/socket'
import type { ApprovalInfo } from '@/components/cyber/approval-card'

export type StreamItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'thought'; text: string }
  | { id: string; kind: 'action'; tool: string; command?: string; check?: string; target?: string; reason?: string }
  | { id: string; kind: 'guard'; refusal: { kind: string; reason: string; fix?: string } }
  | { id: string; kind: 'approval'; approval: ApprovalInfo; resolved?: 'approved' | 'denied' | 'expired' }
  | { id: string; kind: 'run'; runId: number; label: string; output: string; done: boolean; exitCode?: number | null; durationMs?: number; verdict?: string }
  | { id: string; kind: 'finding'; finding: { kind: string; title: string; detail: string; severity?: string } }
  | { id: string; kind: 'honeypot'; analysis: { target: string; score: number; verdict: string; signals: { name: string; detail: string }[]; strategy: string } }
  | { id: string; kind: 'strategy'; strategy: { task: string; primary: { name: string; score: number } | null; ranked: { name: string; score: number }[]; complement?: { tools: string[]; note: string } | null; guidance: string } }
  | { id: string; kind: 'final'; text: string }
  | { id: string; kind: 'error'; message: string; fix?: string }
  | { id: string; kind: 'interrupt' }
  | { id: string; kind: 'turnhead'; mode: string; steps: number }

export type TermTone = 'cmd' | 'ok' | 'bad' | 'warn' | 'info' | 'dim'

export interface TermLine {
  id: string
  ts: number
  sessionId: string
  tone: TermTone
  text: string
}

const TERM_CAP = 800
let idCounter = 0
const nextId = () => `f-${++idCounter}`

interface FeedState {
  streams: Record<string, StreamItem[]>
  busySessions: Record<string, boolean>
  terminal: TermLine[]
  /** console-only extras rendered from the stream (kept per session) */
  pushStreamItem: (sessionId: string, item: StreamItem) => void
  hydrateStream: (sessionId: string, items: StreamItem[]) => void
  setBusy: (sessionId: string, busy: boolean) => void
  markApproval: (sessionId: string, approvalId: string, decision: 'approved' | 'denied' | 'expired') => void
  clearTerminal: () => void
}

export const useAgentFeed = create<FeedState>((set, get) => ({
  streams: {},
  busySessions: {},
  terminal: [],
  pushStreamItem: (sessionId, item) => {
    set((s) => ({ streams: { ...s.streams, [sessionId]: [...(s.streams[sessionId] ?? []), item] } }))
  },
  hydrateStream: (sessionId, items) => {
    // never clobber a live-captured stream with (older) DB history
    if ((get().streams[sessionId] ?? []).length) return
    set((s) => ({ streams: { ...s.streams, [sessionId]: items } }))
  },
  setBusy: (sessionId, busy) => {
    set((s) => ({ busySessions: { ...s.busySessions, [sessionId]: busy } }))
  },
  markApproval: (sessionId, approvalId, decision) => {
    set((s) => {
      const stream = s.streams[sessionId]
      if (!stream) return {}
      return {
        streams: {
          ...s.streams,
          [sessionId]: stream.map((it) =>
            it.kind === 'approval' && it.approval.id === approvalId ? { ...it, resolved: decision } : it
          ),
        },
      }
    })
  },
  clearTerminal: () => set({ terminal: [] }),
}))

// ─── terminal helpers ────────────────────────────────────────────────────────

function term(sessionId: string, tone: TermTone, text: string) {
  useAgentFeed.setState((s) => {
    const line: TermLine = { id: nextId(), ts: Date.now(), sessionId, tone, text }
    const terminal = [...s.terminal, line]
    if (terminal.length > TERM_CAP) terminal.splice(0, terminal.length - TERM_CAP)
    return { terminal }
  })
}

function patchRun(sessionId: string, runId: number, patch: Partial<Extract<StreamItem, { kind: 'run' }>> & { append?: string }) {
  useAgentFeed.setState((s) => {
    const stream = s.streams[sessionId]
    if (!stream) return {}
    // patch the LAST matching unfinished run item (runs never overlap per session)
    let idx = -1
    for (let i = stream.length - 1; i >= 0; i--) {
      const it = stream[i]
      if (it.kind === 'run' && it.runId === runId && !it.done) { idx = i; break }
    }
    if (idx === -1) return {}
    const it = stream[idx] as Extract<StreamItem, { kind: 'run' }>
    const next: Extract<StreamItem, { kind: 'run' }> = {
      ...it,
      ...(patch.append !== undefined ? { output: (it.output + patch.append).slice(-8000) } : {}),
      ...(patch.done !== undefined || patch.exitCode !== undefined ? { done: patch.done ?? it.done, exitCode: patch.exitCode ?? it.exitCode, durationMs: patch.durationMs ?? it.durationMs } : {}),
    }
    const streams = { ...s.streams, [sessionId]: [...stream.slice(0, idx), next, ...stream.slice(idx + 1)] }
    return { streams }
  })
}

function patchFinal(sessionId: string, chunk: string) {
  useAgentFeed.setState((s) => {
    const stream = s.streams[sessionId] ?? []
    let idx = -1
    for (let i = stream.length - 1; i >= 0; i--) {
      if (stream[i].kind === 'turnhead') break
      if (stream[i].kind === 'final') { idx = i; break }
    }
    if (idx !== -1) {
      const it = stream[idx] as Extract<StreamItem, { kind: 'final' }>
      const nextItem = { ...it, text: it.text + chunk }
      return { streams: { ...s.streams, [sessionId]: [...stream.slice(0, idx), nextItem, ...stream.slice(idx + 1)] } }
    }
    const newItem: StreamItem = { id: nextId(), kind: 'final', text: chunk }
    return { streams: { ...s.streams, [sessionId]: [...stream, newItem] } }
  })
}

function patchThought(sessionId: string, chunk: string) {
  useAgentFeed.setState((s) => {
    const stream = s.streams[sessionId] ?? []
    let idx = -1
    for (let i = stream.length - 1; i >= 0; i--) {
      if (stream[i].kind === 'turnhead' || stream[i].kind === 'action') break
      if (stream[i].kind === 'thought') { idx = i; break }
    }
    if (idx !== -1) {
      const it = stream[idx] as Extract<StreamItem, { kind: 'thought' }>
      const nextItem = { ...it, text: it.text + chunk }
      return { streams: { ...s.streams, [sessionId]: [...stream.slice(0, idx), nextItem, ...stream.slice(idx + 1)] } }
    }
    const newItem: StreamItem = { id: nextId(), kind: 'thought', text: chunk }
    return { streams: { ...s.streams, [sessionId]: [...stream, newItem] } }
  })
}

const head = (s: string, n = 160) => s.replace(/\s+/g, ' ').trim().slice(0, n)

// ─── event routing (shared by every consumer) ────────────────────────────────

export function routeAgentEvent(sessionId: string, event: any) {
  const push = (item: StreamItem) => useAgentFeed.getState().pushStreamItem(sessionId, item)
  switch (event.type) {
    case 'user':
      push({ id: nextId(), kind: 'user', text: String(event.text ?? '') })
      term(sessionId, 'cmd', `❯ ${event.text}`)
      break
    case 'agent_start':
      push({ id: nextId(), kind: 'turnhead', mode: event.mode, steps: event.maxSteps })
      useAgentFeed.getState().setBusy(sessionId, true)
      term(sessionId, 'dim', `── turn start · mode ${event.mode} · budget ${event.maxSteps} steps ──`)
      break
    case 'budget':
      if (event.promptTokens != null) term(sessionId, 'dim', `· step ${event.stepsLeft} left · prompt ≈ ${event.promptTokens} tokens`)
      break
    case 'thought_chunk':
      patchThought(sessionId, String(event.chunk ?? ''))
      break
    case 'final_chunk':
      patchFinal(sessionId, String(event.chunk ?? ''))
      break
    case 'agent_thought': {
      useAgentFeed.setState((s) => {
        const stream = s.streams[sessionId] ?? []
        let idx = -1
        for (let i = stream.length - 1; i >= 0; i--) {
          if (stream[i].kind === 'turnhead' || stream[i].kind === 'action') break
          if (stream[i].kind === 'thought') { idx = i; break }
        }
        if (idx !== -1) {
          const updated = { ...stream[idx], text: event.text }
          return { streams: { ...s.streams, [sessionId]: [...stream.slice(0, idx), updated, ...stream.slice(idx + 1)] } }
        }
        return { streams: { ...s.streams, [sessionId]: [...stream, { id: nextId(), kind: 'thought', text: event.text }] } }
      })
      term(sessionId, 'dim', `· ${head(event.text ?? '', 140)}`)
      break
    }
    case 'action': {
      const cmd = event.command ? `${event.command}` : `${event.tool}${event.check ? ` ${event.check}` : ''}${event.target ? ` ${event.target}` : ''}`
      push({ id: nextId(), kind: 'action', tool: event.tool, command: event.command, check: event.check, target: event.target, reason: event.reason })
      term(sessionId, 'cmd', `$ ${cmd}`)
      break
    }
    case 'guard':
      push({ id: nextId(), kind: 'guard', refusal: event.refusal })
      term(sessionId, 'bad', `✗ REFUSED [${event.refusal?.kind}] ${head(event.refusal?.reason ?? '', 180)}${event.refusal?.fix ? ` — FIX: ${head(event.refusal.fix, 120)}` : ''}`)
      break
    case 'approval_required':
      push({ id: nextId(), kind: 'approval', approval: event.approval })
      term(sessionId, 'warn', `⏸ approval requested: ${head(event.approval?.command ?? '', 160)} (${event.approval?.reason ?? ''})`)
      break
    case 'approval_resolved':
      useAgentFeed.getState().markApproval(sessionId, event.id, event.decision ?? 'approved')
      term(sessionId, 'info', `approval ${event.decision ?? 'resolved'}`)
      break
    case 'output_start':
      push({ id: nextId(), kind: 'run', runId: event.runId, label: event.label, output: '', done: false })
      break
    case 'output':
      patchRun(sessionId, event.runId, { append: String(event.chunk ?? '') })
      break
    case 'output_end': {
      patchRun(sessionId, event.runId, { done: true, exitCode: event.exitCode, durationMs: event.durationMs, verdict: event.verdict })
      const isKilled = event.verdict === 'killed'
      const isStopped = event.verdict === 'interrupted'
      const ok = event.exitCode === 0 && !isKilled && !isStopped
      const secs = event.durationMs != null ? `${(event.durationMs / 1000).toFixed(1)}s` : '?'
      const statusText = isKilled
        ? '✗ KILLED (emergency kill switch)'
        : isStopped
          ? '⏹ STOPPED (interrupted by operator)'
          : `${ok ? '✓' : '✗'} exit=${event.exitCode ?? '?'}${event.timedOut ? ' (TIMED OUT — partial output above)' : ''}`
      term(sessionId, ok ? 'ok' : 'bad', `${statusText} (${secs})`)
      break
    }
    case 'finding':
      push({ id: nextId(), kind: 'finding', finding: event.finding })
      term(sessionId, 'ok', `⚑ finding [${event.finding?.severity ?? 'info'}] ${head(event.finding?.title ?? '', 150)}`)
      break
    case 'honeypot':
      push({ id: nextId(), kind: 'honeypot', analysis: event.analysis })
      term(sessionId, 'warn', `☂ honeypot ${event.analysis?.target} → ${event.analysis?.verdict} (score ${event.analysis?.score})`)
      break
    case 'tool_strategy':
      push({ id: nextId(), kind: 'strategy', strategy: event.strategy })
      term(sessionId, 'dim', `strategy ${event.strategy?.task} → ${event.strategy?.primary?.name ?? 'none'}`)
      break
    case 'stop_requested':
      push({ id: nextId(), kind: 'interrupt' })
      term(sessionId, 'warn', '⏹ stop requested — killing in-flight commands, ending the turn…')
      break
    case 'final': {
      useAgentFeed.setState((s) => {
        const stream = s.streams[sessionId] ?? []
        let idx = -1
        for (let i = stream.length - 1; i >= 0; i--) {
          if (stream[i].kind === 'turnhead') break
          if (stream[i].kind === 'final') { idx = i; break }
        }
        if (idx !== -1) {
          const updated = { ...stream[idx], text: event.text }
          return { streams: { ...s.streams, [sessionId]: [...stream.slice(0, idx), updated, ...stream.slice(idx + 1)] } }
        }
        return { streams: { ...s.streams, [sessionId]: [...stream, { id: nextId(), kind: 'final', text: event.text }] } }
      })
      term(sessionId, 'ok', `■ final: ${head(event.text ?? '', 220)}`)
      break
    }
    case 'error':
      push({ id: nextId(), kind: 'error', message: event.message, fix: event.fix })
      term(sessionId, 'bad', `error: ${head(event.message ?? '', 180)}${event.fix ? ` — ${head(event.fix, 120)}` : ''}`)
      break
    case 'agent_end':
      useAgentFeed.getState().setBusy(sessionId, false)
      term(sessionId, 'dim', `── turn end (${event.steps} steps) ──`)
      break
  }
}

// ─── the ONE global socket listener ─────────────────────────────────────────

let installed = false

export function initFeed() {
  if (installed || typeof window === 'undefined') return
  installed = true
  const socket = getSocket()
  if (!socket) return

  socket.on('feed:event', (payload: { sessionId?: string; event?: any }) => {
    if (payload?.sessionId && payload?.event) routeAgentEvent(payload.sessionId, payload.event)
  })
  socket.on('tool:registered', (d: any) => term('*', 'info', `tool registered: ${d?.name ?? d?.id ?? ''} — on the board next action`))
  socket.on('tool:removed', (d: any) => term('*', 'info', `tool removed: ${d?.id ?? ''}`))
  socket.on('kill:changed', (d: any) => {
    term('*', 'warn', `kill switch ${d?.enabled ? 'ON — all commands blocked' : 'off'}`)
    if (d?.enabled) {
      // Emergency kill switch armed — mark all active runs as done and unlock busy state immediately
      useAgentFeed.setState((s) => {
        const nextStreams: Record<string, StreamItem[]> = {}
        for (const [sId, items] of Object.entries(s.streams)) {
          nextStreams[sId] = items.map((it) => {
            if (it.kind === 'run' && !it.done) {
              return { ...it, done: true, exitCode: -1, verdict: 'killed' }
            }
            return it
          })
        }
        return {
          busySessions: {},
          streams: nextStreams,
        }
      })
    }
  })
  socket.on('mode:changed', (d: any) => term('*', 'warn', `mode → ${d?.mode ?? '?'}`))
  socket.on('approval:updated', (d: any) => term('*', 'info', `approval ${d?.id ?? ''} ${d?.decision ?? ''}`))
}
