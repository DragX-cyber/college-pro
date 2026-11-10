'use client'
import { useEffect, useRef, useState } from 'react'
import { useRedline } from '@/lib/redline-store'
import { useAgentFeed, type StreamItem } from '@/lib/agent-feed'
import { getSocket } from '@/lib/socket'
import { useToast } from '@/hooks/use-toast'
import { GlitchTitle, Panel, SectionLabel, Chip, ModeBadge, HoneypotBadge, SeverityBadge } from '@/components/cyber/primitives'
import { ApprovalCard } from '@/components/cyber/approval-card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Cpu, Send, Skull, Bug, ChevronRight, Square } from 'lucide-react'
import { cn } from '@/lib/utils'

const EMPTY_STREAM: StreamItem[] = []

export default function ConsoleView() {
  const { sessionId, system, setThinkingLevel } = useRedline()
  const { toast } = useToast()
  // the stream lives in the global feed store: switching views (or being
  // elsewhere while the agent works) never loses the chat
  const items = useAgentFeed((s) => s.streams[sessionId] ?? EMPTY_STREAM)
  const busy = useAgentFeed((s) => !!s.busySessions[sessionId])
  const [input, setInput] = useState('')
  const [taskLabels, setTaskLabels] = useState<Record<string, string>>({})
  const [strategyOut, setStrategyOut] = useState<any>(null)
  const [taskSel, setTaskSel] = useState('port_scan')
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // boot: persisted history (only when no live stream exists yet) + labels
  useEffect(() => {
    if (!useAgentFeed.getState().streams[sessionId]?.length) {
      fetch(`/api/sessions/${sessionId}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d?.session) return
          const hist: StreamItem[] = []
          let n = 0
          for (const m of d.session.messages as any[]) {
            const id = `h-${n++}`
            if (m.role === 'user') hist.push({ id, kind: 'user', text: m.content })
            else if (m.role === 'assistant' && m.content) hist.push({ id, kind: 'final', text: m.content })
          }
          useAgentFeed.getState().hydrateStream(sessionId, hist)
        })
        .catch(() => {})
    }
    fetch('/api/marketplace', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setTaskLabels(d.taskLabels ?? {}))
      .catch(() => {})
  }, [sessionId])

  // auto scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [items])

  const send = () => {
    const text = input.trim()
    if (!text || busy) return
    const socket = getSocket()
    if (!socket || !socket.connected) {
      toast({
        title: 'AGENT SERVICE UNREACHABLE',
        description: 'Start it in a separate terminal with: bun run service — then retry.',
        variant: 'destructive',
      })
      return
    }
    setInput('')
    useAgentFeed.getState().setBusy(sessionId, true)
    socket.emit('chat:send', { sessionId, text }) // the user line echoes back via feed:event
  }

  const lookupStrategy = (task: string) => {
    setTaskSel(task)
    const socket = getSocket()
    socket?.emit('tool:strategy', { task, priority: 'balanced' }, (s: any) => setStrategyOut(s))
  }

  // Operator interrupt: flag the turn loop AND kill in-flight commands now.
  // The orchestrator still runs its normal teardown (progress summary +
  // history save + agent_end), so the input unlocks and a refined prompt
  // can be sent right away.
  const stop = () => {
    const socket = getSocket()
    if (!socket || !socket.connected) {
      toast({ title: 'AGENT SERVICE UNREACHABLE', variant: 'destructive' })
      return
    }
    socket.emit('chat:stop', { sessionId })
    toast({ title: 'STOP REQUESTED', description: 'In-flight commands are being killed — the turn ends at the next safe step.' })
  }

  const sessionFindings = items.filter((i): i is Extract<StreamItem, { kind: 'finding' }> => i.kind === 'finding')
  const honeypots = items.filter((i): i is Extract<StreamItem, { kind: 'honeypot' }> => i.kind === 'honeypot')

  return (
    <div className="flex h-[calc(100vh-2.2rem)] flex-col gap-3 p-3 md:p-4 xl:flex-row">
      {/* chat stream */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <GlitchTitle text="CONSOLE" className="text-lg text-[var(--neon-cyan)]" />
          <ModeBadge mode={system?.mode ?? 'free'} />

          {/* Thinking Level Toggle */}
          <div className="flex items-center gap-1 rounded-sm border border-border/70 bg-black/40 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em]">
            <span className="mr-1 font-mono text-[9px] text-muted-foreground/80">THINK:</span>
            {(['low', 'medium', 'high'] as const).map((lvl) => {
              const active = (system?.thinkingLevel ?? 'medium') === lvl
              const colorCls = {
                low: active
                  ? 'border-[var(--neon-cyan)]/60 bg-[var(--neon-cyan)]/20 text-[var(--neon-cyan)] shadow-[0_0_8px_rgba(0,229,255,0.4)]'
                  : 'text-muted-foreground hover:text-foreground border-transparent',
                medium: active
                  ? 'border-[var(--neon-acid)]/60 bg-[var(--neon-acid)]/20 text-[var(--neon-acid)] shadow-[0_0_8px_rgba(249,240,2,0.35)]'
                  : 'text-muted-foreground hover:text-foreground border-transparent',
                high: active
                  ? 'border-[var(--neon-magenta)]/60 bg-[var(--neon-magenta)]/20 text-[var(--neon-magenta)] shadow-[0_0_8px_rgba(255,42,109,0.4)]'
                  : 'text-muted-foreground hover:text-foreground border-transparent',
              }[lvl]
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setThinkingLevel(lvl)}
                  className={cn(
                    'rounded-[2px] border px-1.5 py-0.5 font-bold transition-all',
                    colorCls
                  )}
                  title={`Thinking Level: ${lvl.toUpperCase()} — ${lvl === 'low' ? 'Fast 1-line tactical thought (conserves VRAM/tokens)' : lvl === 'medium' ? 'Deliberate 3-point check ([GOAL] | [EVIDENCE] | [DECISION])' : 'Deep 4-step strategic analysis ([OBJECTIVE] | [SURFACE] | [HYPOTHESIS] | [DECISION])'}`}
                >
                  {lvl}
                </button>
              )
            })}
          </div>

          {busy && <Chip tone="green">AGENT WORKING<span className="pulse-dot">…</span></Chip>}
          {system?.killSwitch && <Chip tone="red">KILL SWITCH ON</Chip>}
        </div>

        <div ref={scrollRef} className="term-scroll min-h-0 flex-1 space-y-2 overflow-y-auto rounded-sm border border-border/50 bg-black/25 p-3">
          {items.length === 0 && (
            <div className="space-y-2 p-4 text-[11px] leading-relaxed text-muted-foreground flicker-in">
              <p className="text-foreground/80">▌ READY. The agent knows: its OS ({system?.os?.platform ?? '…'}{system?.os?.wsl.preferred ? ` + WSL ${system.os.wsl.preferred}` : ''}), its {system?.tools.length ?? 0} tools with speed/flaw profiles, and the charter ({system?.charter?.hosts.join(', ') ?? '—'}).</p>
              <p>Try: <span className="text-[var(--neon-cyan)]">“recon localhost and tell me what&apos;s listening”</span> · <span className="text-[var(--neon-cyan)]">“what&apos;s the fastest way to port-scan our target?”</span> · <span className="text-[var(--neon-cyan)]">“check if 10.10.10.5 is a honeypot first”</span></p>
              <p className="text-muted-foreground/70">FREE TERMINAL: read-only commands run instantly; anything else raises an approval card. GUARDED: only the 4 closed checks. UNRESTRICTED: red banner, no egress, no cards.</p>
            </div>
          )}

          {items.map((it) => {
            switch (it.kind) {
              case 'turnhead':
                return (
                  <div key={it.id} className="flex items-center gap-2 pt-2 text-[9px] uppercase tracking-[0.3em] text-muted-foreground/60">
                    <span className="h-px flex-1 bg-border/60" />
                    turn · {it.mode} · budget {it.steps} steps
                    <span className="h-px flex-1 bg-border/60" />
                  </div>
                )
              case 'user':
                return (
                  <div key={it.id} className="rise-in flex justify-end">
                    <div className="max-w-[85%] rounded-sm border border-primary/40 bg-primary/10 px-3 py-2 text-[12px] leading-relaxed text-foreground">
                      <span className="mr-1 text-[var(--neon-cyan)]">❯</span>{it.text}
                    </div>
                  </div>
                )
              case 'thought': {
                const isStreamingThought = busy && it.id === items[items.length - 1]?.id
                return (
                  <div key={it.id} className="rise-in flex items-start gap-2 text-[11px] italic text-muted-foreground">
                    <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-[var(--neon-magenta)]/70" aria-hidden />
                    <span className="max-w-[85%] whitespace-pre-wrap leading-relaxed">
                      {it.text}
                      {isStreamingThought && <span className="inline-block w-1 h-3 ml-1 bg-muted-foreground/60 animate-pulse align-middle" />}
                    </span>
                  </div>
                )
              }
              case 'action':
                return (
                  <div key={it.id} className="rise-in rounded-sm border border-[var(--neon-cyan)]/30 bg-[var(--neon-cyan)]/5 px-3 py-2">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-[9px] uppercase tracking-[0.25em] text-[var(--neon-cyan)]">
                      ▶ action · {it.tool}
                      {it.reason && <span className="text-muted-foreground normal-case tracking-normal">— {it.reason}</span>}
                    </div>
                    {it.command && (
                      <pre className="overflow-x-auto text-[11px] leading-relaxed text-[var(--neon-acid)]">$ {it.command}</pre>
                    )}
                    {!it.command && (
                      <div className="text-[11px] text-[var(--neon-acid)]">
                        check: <b>{it.check}</b> → {it.target}
                      </div>
                    )}
                  </div>
                )
              case 'guard':
                return (
                  <div key={it.id} className="rise-in rounded-sm border border-[var(--neon-red)]/50 bg-[var(--neon-red)]/8 px-3 py-2">
                    <div className="text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--neon-red)]">
                      ⛔ guard · {it.refusal.kind}
                    </div>
                    <div className="mt-1 text-[11px] leading-relaxed text-foreground/90">{it.refusal.reason}</div>
                    {it.refusal.fix && <div className="mt-1 text-[10px] text-[var(--neon-green)]">fix: {it.refusal.fix}</div>}
                  </div>
                )
              case 'approval':
                return <ApprovalCard key={it.id} approval={it.approval} />
              case 'run':
                return (
                  <div key={it.id} className="rise-in overflow-hidden rounded-sm border border-border/60 bg-black/45">
                    <div className="flex items-center justify-between border-b border-border/50 bg-muted/20 px-2 py-1">
                      <span className="truncate text-[9px] uppercase tracking-[0.22em] text-[var(--neon-green)]">┌ {it.label}</span>
                      {it.done ? (
                        <span className={cn('shrink-0 text-[9px] tabular-nums font-mono', (it as any).verdict === 'killed' ? 'text-[var(--neon-red)] font-bold' : it.exitCode === 0 ? 'text-[var(--neon-green)]' : 'text-[var(--neon-amber)]')}>
                          {(it as any).verdict === 'killed' ? 'KILLED' : `exit ${it.exitCode ?? '—'}`} · {((it.durationMs ?? 0) / 1000).toFixed(1)}s
                        </span>
                      ) : (
                        <span className="shrink-0 text-[9px] text-[var(--neon-green)] pulse-dot">streaming…</span>
                      )}
                    </div>
                    <pre className="term-scroll max-h-56 overflow-auto whitespace-pre-wrap break-all px-2 py-1.5 text-[10.5px] leading-relaxed text-foreground/80">
                      {it.output || '(waiting for output)'}
                    </pre>
                  </div>
                )
              case 'finding':
                return (
                  <div key={it.id} className="rise-in flex items-start gap-2 rounded-sm border border-[var(--neon-acid)]/40 bg-[var(--neon-acid)]/5 px-3 py-2">
                    <Bug className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--neon-acid)]" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <SeverityBadge severity={it.finding.severity ?? 'info'} />
                        <span className="text-[11px] text-foreground">{it.finding.title}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{it.finding.detail.slice(0, 220)}</div>
                    </div>
                  </div>
                )
              case 'honeypot':
                return (
                  <div key={it.id} className="rise-in rounded-sm border border-[var(--neon-magenta)]/50 bg-[var(--neon-magenta)]/8 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Skull className="h-3.5 w-3.5 text-[var(--neon-magenta)]" aria-hidden />
                      <HoneypotBadge verdict={it.analysis.verdict} score={it.analysis.score} />
                      <span className="text-[11px] text-foreground">{it.analysis.target}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      signals: {it.analysis.signals.map((s) => s.name).join(' · ')}
                    </div>
                    <div className="mt-1 text-[10px] leading-relaxed text-[var(--neon-magenta)]/90">{it.analysis.strategy}</div>
                  </div>
                )
              case 'strategy':
                return (
                  <div key={it.id} className="rise-in rounded-sm border border-[var(--neon-acid)]/30 bg-[var(--neon-acid)]/5 px-3 py-2">
                    <div className="text-[9px] uppercase tracking-[0.25em] text-[var(--neon-acid)]">strategy board · {it.strategy.task}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                      {it.strategy.ranked.slice(0, 4).map((c, i) => (
                        <span key={c.name} className={cn(i === 0 ? 'text-[var(--neon-green)]' : 'text-muted-foreground')}>
                          {i + 1}. {c.name} <span className="tabular-nums opacity-70">({c.score})</span>
                        </span>
                      ))}
                    </div>
                    {it.strategy.complement && (
                      <div className="mt-1 text-[10px] leading-relaxed text-[var(--neon-cyan)]/90">
                        complement: {it.strategy.complement.note.slice(0, 260)}
                      </div>
                    )}
                  </div>
                )
              case 'interrupt':
                return (
                  <div key={it.id} className="rise-in flex items-center gap-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-[var(--neon-amber)]">
                    <Square className="h-3 w-3 shrink-0" aria-hidden /> interrupt — stop requested, ending the turn
                  </div>
                )
              case 'error':
                return (
                  <div key={it.id} className="rise-in rounded-sm border border-[var(--neon-amber)]/50 bg-[var(--neon-amber)]/8 px-3 py-2">
                    <div className="text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--neon-amber)]">⚠ error</div>
                    <div className="mt-1 text-[11px] leading-relaxed">{it.message}</div>
                    {it.fix && <div className="mt-1 text-[10px] text-[var(--neon-green)]">{it.fix}</div>}
                  </div>
                )
              case 'final': {
                const isStreamingFinal = busy && it.id === items[items.length - 1]?.id
                return (
                  <div key={it.id} className="rise-in rounded-sm border border-[var(--neon-green)]/40 bg-[var(--neon-green)]/6 px-3 py-2">
                    <div className="mb-1 flex items-center justify-between text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--neon-green)]">
                      <span>■ REDLINE</span>
                      {isStreamingFinal && <span className="text-[9px] font-normal normal-case tracking-normal pulse-dot text-[var(--neon-green)]">streaming…</span>}
                    </div>
                    <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground">
                      {it.text}
                      {isStreamingFinal && <span className="inline-block w-1.5 h-3.5 ml-1 bg-[var(--neon-green)] animate-pulse align-middle" />}
                    </div>
                  </div>
                )
              }
              default:
                return null
            }
          })}
          <div ref={bottomRef} />
        </div>

        <div className="mt-2 flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            }}
            rows={2}
            disabled={busy}
            placeholder={busy ? 'agent is working — approvals still clickable…' : '❯ task the agent (Enter to send, Shift+Enter for newline)'}
            className="term-scroll min-h-[52px] flex-1 resize-none rounded-sm border border-input bg-black/40 px-3 py-2 text-[12px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-ring/40 disabled:opacity-50"
          />
          <Button
            onClick={stop}
            disabled={!busy}
            title={busy ? 'Interrupt the turn and take the prompt back' : 'Nothing running'}
            className="btn-neon h-[52px] border border-[var(--neon-red)]/60 bg-[var(--neon-red)]/15 text-[var(--neon-red)] hover:bg-[var(--neon-red)]/25 disabled:opacity-30"
          >
            <Square className="h-4 w-4" />
          </Button>
          <Button
            onClick={send}
            disabled={busy || !input.trim()}
            className="btn-neon h-[52px] border border-primary/50 bg-primary/15 text-primary hover:bg-primary/25"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* right rail */}
      <aside className="flex w-full shrink-0 flex-col gap-3 xl:w-80">
        <Panel title="Tool strategy lookup">
          <Select value={taskSel} onValueChange={lookupStrategy}>
            <SelectTrigger className="btn-neon border-border bg-black/40 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-border bg-popover">
              {Object.entries(taskLabels).map(([id, label]) => (
                <SelectItem key={id} value={id} className="text-[11px]">{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {strategyOut && (
            <div className="mt-2 space-y-1.5 text-[10.5px] leading-relaxed">
              <div className="text-[var(--neon-green)]">→ {strategyOut.primary ? `${strategyOut.primary.name} (${strategyOut.primary.score}/10)` : 'no tool covers this yet — check the Market'}</div>
              {strategyOut.ranked?.slice(1, 4).map((c: any) => (
                <div key={c.id} className="text-muted-foreground">· {c.name} — {c.score}/10 · {c.rationale?.slice(0, 90)}</div>
              ))}
              {strategyOut.complement && <div className="text-[var(--neon-cyan)]">{strategyOut.complement.note.slice(0, 220)}</div>}
            </div>
          )}
        </Panel>

        <Panel title="Session intel">
          <div className="space-y-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
            <div className="flex items-center gap-2"><Cpu className="h-3 w-3 text-[var(--neon-cyan)]" aria-hidden /> {system?.os ? `${system.os.platform} · ${system.os.exec.kind}` : '…'}</div>
            <div>targets: <span className="text-[var(--neon-cyan)]">{system?.charter?.hosts.join(', ') ?? '—'}</span></div>
            <div>tools ready: <span className="text-[var(--neon-green)]">{system?.tools.filter((t) => t.availability === 'available').length ?? 0}</span> / {system?.tools.length ?? 0}</div>
            <div>budget: {system ? `${system.budgets.stepsPerTurn} steps · ${system.budgets.turnSeconds}s` : '…'}</div>
          </div>
        </Panel>

        <Panel title={`Findings (${sessionFindings.length}) · Honeypots (${honeypots.length})`} bodyClassName="p-0">
          <div className="term-scroll max-h-56 overflow-y-auto">
            {sessionFindings.length === 0 && honeypots.length === 0 && (
              <div className="p-3 text-[10px] text-muted-foreground">Nothing recorded in this session yet.</div>
            )}
            {honeypots.map((h) => (
              <div key={h.id} className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-[10px]">
                <HoneypotBadge verdict={h.analysis.verdict} score={h.analysis.score} />
                <span className="truncate">{h.analysis.target}</span>
              </div>
            ))}
            {sessionFindings.map((f) => (
              <div key={f.id} className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-[10px]">
                <SeverityBadge severity={f.finding.severity ?? 'info'} />
                <span className="truncate text-muted-foreground">{f.finding.title}</span>
              </div>
            ))}
          </div>
        </Panel>
      </aside>
    </div>
  )
}
