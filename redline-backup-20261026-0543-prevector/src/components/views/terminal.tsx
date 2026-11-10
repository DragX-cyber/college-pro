'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRedline } from '@/lib/redline-store'
import { useAgentFeed, type TermTone } from '@/lib/agent-feed'
import { GlitchTitle, SectionLabel, Chip } from '@/components/cyber/primitives'
import { Button } from '@/components/ui/button'
import { Trash2, ArrowDown } from 'lucide-react'
import { cn } from '@/lib/utils'

const TONE_CLASS: Record<TermTone, string> = {
  cmd: 'text-[var(--neon-cyan)]',
  ok: 'text-[var(--neon-green)]',
  bad: 'text-[var(--neon-red)]',
  warn: 'text-[var(--neon-amber)]',
  info: 'text-[var(--neon-cyan)]/80',
  dim: 'text-muted-foreground',
}

const FILTERS = [
  { id: 'all', label: 'ALL' },
  { id: 'commands', label: 'COMMANDS' },
  { id: 'blocked', label: 'GUARDS' },
  { id: 'results', label: 'RESULTS' },
] as const
type FilterId = (typeof FILTERS)[number]['id']

function keepLine(tone: TermTone, filter: FilterId): boolean {
  if (filter === 'all') return true
  if (filter === 'commands') return tone === 'cmd' || tone === 'dim'
  if (filter === 'blocked') return tone === 'bad' || tone === 'warn'
  return tone === 'ok' // results: findings, finals, exit lines
}

export default function TerminalView() {
  const sessionId = useRedline((s) => s.sessionId)
  const terminal = useAgentFeed((s) => s.terminal)
  const clearTerminal = useAgentFeed((s) => s.clearTerminal)
  const [filter, setFilter] = useState<FilterId>('all')
  const [paused, setPaused] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  const lines = useMemo(() => terminal.filter((l) => keepLine(l.tone, filter)), [terminal, filter])

  useEffect(() => {
    if (paused || !atBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length, paused])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const jumpToBottom = () => {
    setPaused(false)
    atBottomRef.current = true
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-2.2rem)] max-w-6xl flex-col gap-3 p-3 md:p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <GlitchTitle text="MAIN TERMINAL" className="text-lg text-[var(--neon-green)]" />
          <SectionLabel>everything the AI does, live — every command, guard verdict, approval and finding, across all sessions</SectionLabel>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone="green">{terminal.length} events</Chip>
          <Button size="sm" variant={paused ? 'default' : 'outline'} onClick={() => setPaused((p) => !p)} className="btn-neon h-7 border-border px-3 text-[9px]">
            {paused ? 'resume stream' : 'pause stream'}
          </Button>
          <Button size="sm" variant="outline" onClick={jumpToBottom} className="btn-neon h-7 border-border px-2 text-[9px]" title="jump to latest">
            <ArrowDown className="h-3 w-3" aria-hidden />
          </Button>
          <Button size="sm" variant="outline" onClick={clearTerminal} className="btn-neon h-7 border-border px-2 text-[9px] hover:text-[var(--neon-red)]" title="clear the terminal view">
            <Trash2 className="h-3 w-3" aria-hidden />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'rounded-sm border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider transition-colors',
              filter === f.id ? 'border-[var(--neon-green)]/50 bg-[var(--neon-green)]/10 text-[var(--neon-green)]' : 'border-border/60 text-muted-foreground hover:text-foreground'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="term-scroll min-h-0 flex-1 overflow-y-auto rounded-sm border border-[var(--neon-green)]/25 bg-black/60 p-3 font-mono text-[11px] leading-relaxed"
      >
        {lines.length === 0 && (
          <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
            <div className="text-center">
              <div className="mb-1 text-[var(--neon-green)]/60">▌ AWAITING AGENT ACTIVITY</div>
              <div className="text-[10px]">chat in the Console (or run a turn anywhere) — every action lands here in real time</div>
            </div>
          </div>
        )}
        {lines.map((l) => {
          const ts = new Date(l.ts).toLocaleTimeString([], { hour12: false })
          const mine = l.sessionId === sessionId
          return (
            <div key={l.id} className="flex gap-2 whitespace-pre-wrap break-words">
              <span className="shrink-0 select-none text-muted-foreground/60">{ts}</span>
              {!mine && <span className="shrink-0 select-none text-[var(--neon-magenta)]/70" title={`session ${l.sessionId}`}>{l.sessionId.slice(0, 8)}</span>}
              <span className={cn('min-w-0', TONE_CLASS[l.tone])}>{l.text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
