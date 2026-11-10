'use client'
import { useEffect, useRef, useState } from 'react'
import { getSocket } from '@/lib/socket'
import { GlitchTitle, Panel, SectionLabel, Chip } from '@/components/cyber/primitives'
import { cn } from '@/lib/utils'

interface AuditRow { id: number; ts: string; kind: string; mode: string; actor: string; verdict: string | null; detail: string }

const KINDS = [
  'all', 'command_executed', 'free_command_refused', 'scope_refused', 'off_target_refused',
  'command_blocked', 'command_approved', 'command_denied', 'kill_switch', 'rate_limited',
  'loop_blocked', 'mode_changed', 'unrestricted_enabled', 'tool_registered', 'honeypot_flagged',
  'engagement_started', 'engagement_completed', 'approval_timeout', 'engagement_gate',
]

export default function AuditView() {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [kind, setKind] = useState('all')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const load = async () => {
      const url = kind === 'all' ? '/api/audit?limit=200' : `/api/audit?limit=200&kind=${kind}`
      const r = await fetch(url, { cache: 'no-store' }).then((x) => x.json()).catch(() => null)
      if (r?.events) setRows(r.events)
    }
    void load()
  }, [kind])

  useEffect(() => {
    const socket = getSocket()
    const onAudit = (e: AuditRow) => {
      setRows((prev) => (kind === 'all' || kind === e.kind ? [e, ...prev].slice(0, 400) : prev))
    }
    socket?.on('audit:event', onAudit)
    return () => { socket?.off('audit:event', onAudit) }
  }, [kind])

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div>
        <GlitchTitle text="AUDIT TRAIL" className="text-lg text-[var(--neon-cyan)]" />
        <SectionLabel>every gate verdict, every command, every refusal — evidence the guard worked</SectionLabel>
      </div>

      <div className="flex flex-wrap gap-1">
        {KINDS.map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={cn(
              'btn-neon rounded-sm border px-2 py-1 text-[9.5px]',
              kind === k ? 'border-primary/60 bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-muted/40'
            )}
          >
            {k}
          </button>
        ))}
      </div>

      <Panel title={`${rows.length} events · live`} bodyClassName="p-0">
        <div className="term-scroll max-h-[70vh] overflow-y-auto">
          {rows.length === 0 && <div className="p-4 text-[11px] text-muted-foreground">No events for this filter yet.</div>}
          {rows.map((a) => {
            let d: any = {}
            try { d = JSON.parse(a.detail) } catch { /* raw */ }
            return (
              <details key={a.id} className="border-b border-border/40 last:border-0">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[10px] hover:bg-muted/30">
                  <span className="w-16 shrink-0 tabular-nums text-muted-foreground/60">{new Date(a.ts).toLocaleTimeString()}</span>
                  <Chip tone={a.verdict === 'allowed' ? 'green' : a.verdict === 'refused' || a.verdict === 'blocked' ? 'red' : 'muted'}>{a.kind}</Chip>
                  <span className="w-14 shrink-0 truncate text-muted-foreground">{a.actor}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {d.command ?? d.reason ?? d.host ?? d.tool ?? d.action ?? d.target ?? a.mode}
                  </span>
                  <Chip>{a.mode}</Chip>
                </summary>
                <pre className="term-scroll max-h-48 overflow-auto whitespace-pre-wrap break-all bg-black/30 px-4 py-2 text-[10px] leading-relaxed text-muted-foreground">
                  {JSON.stringify(d, null, 2)}
                </pre>
              </details>
            )
          })}
          <div ref={bottomRef} />
        </div>
      </Panel>
    </div>
  )
}
