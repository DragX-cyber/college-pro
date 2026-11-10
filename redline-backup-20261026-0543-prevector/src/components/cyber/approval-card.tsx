'use client'
import { useEffect, useState } from 'react'
import { getSocket } from '@/lib/socket'
import { Button } from '@/components/ui/button'
import { Chip } from './primitives'
import { cn } from '@/lib/utils'

export interface ApprovalInfo {
  id: string
  tool: string
  command: string
  reason: string
  mode: string
}

/** The approval card — shows the EXACT command and waits for the operator.
 *  Approve/Deny resume the agent loop instantly via the socket service. */
export function ApprovalCard({ approval, onResolved }: { approval: ApprovalInfo; onResolved?: (id: string, decision: string) => void }) {
  const [decision, setDecision] = useState<string | null>(null)
  const [left, setLeft] = useState(180)

  useEffect(() => {
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [])

  const decide = (d: 'approved' | 'denied') => {
    if (decision) return
    setDecision(d)
    const socket = getSocket()
    socket?.emit('approval:decide', { id: approval.id, decision: d })
    fetch(`/api/approvals/${approval.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: d }),
    }).catch(() => {}) // REST backup path — resolves cards raised by other runners
    onResolved?.(approval.id, d)
  }

  return (
    <div
      className={cn(
        'cyber-panel cyber-panel-accent rounded-sm p-3 rise-in',
        decision === 'approved' && 'opacity-60',
        decision === 'denied' && 'opacity-40 grayscale'
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Chip tone="amber">APPROVAL REQUIRED</Chip>
        <Chip tone="cyan">{approval.tool}</Chip>
        <Chip>mode: {approval.mode}</Chip>
        <span className="ml-auto tabular-nums text-[10px] text-muted-foreground">
          {decision ? decision.toUpperCase() : `expires in ${left}s`}
        </span>
      </div>
      <pre className="mb-1 overflow-x-auto rounded-sm border border-border/70 bg-black/40 p-2 text-[11px] leading-relaxed text-[var(--neon-acid)]">
$ {approval.command}
      </pre>
      <p className="mb-2 text-[11px] text-muted-foreground">{approval.reason}</p>
      {!decision && (
        <div className="flex gap-2">
          <Button
            size="sm"
            className="btn-neon flex-1 border border-[var(--neon-green)]/50 bg-[var(--neon-green)]/15 text-[var(--neon-green)] hover:bg-[var(--neon-green)]/25"
            onClick={() => decide('approved')}
          >
            APPROVE — RUN IT
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="btn-neon flex-1 border border-[var(--neon-red)]/50 text-[var(--neon-red)] hover:bg-[var(--neon-red)]/10"
            onClick={() => decide('denied')}
          >
            DENY — NEVER RUNS
          </Button>
        </div>
      )}
    </div>
  )
}
