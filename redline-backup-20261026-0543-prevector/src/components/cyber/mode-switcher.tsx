'use client'
import { useEffect, useState } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import { getSocket } from '@/lib/socket'
import { useRedline } from '@/lib/redline-store'
import { cn } from '@/lib/utils'
import type { Mode } from '@/core/types'

const MODES: { id: Mode; label: string; hint: string; cls: string }[] = [
  { id: 'guarded', label: 'GUARDED', hint: 'closed action set · fully deterministic', cls: 'text-[var(--neon-cyan)]' },
  { id: 'free', label: 'FREE', hint: 'agentic terminal with guardrails', cls: 'text-[var(--neon-green)]' },
  { id: 'unrestricted', label: 'UNRESTRICTED', hint: 'no charter egress · no approval cards', cls: 'text-[var(--neon-red)]' },
]

export function ModeSwitcher({ compact }: { compact?: boolean }) {
  const { toast } = useToast()
  const mode = useRedline((s) => s.system?.mode ?? 'free')
  const endurance = useRedline((s) => s.system?.endurance ?? false)
  const setMode = useRedline((s) => s.setMode)
  const [warnOpen, setWarnOpen] = useState(false)

  // surface service-side rejections (e.g. missing confirm) instead of failing silently
  useEffect(() => {
    const socket = getSocket()
    const onRejected = ({ reason }: { reason: string }) => {
      toast({ title: 'Mode rejected', description: reason, variant: 'destructive' })
      void useRedline.getState().refreshSystem()
    }
    const onLimits = ({ endurance: e }: { endurance: boolean }) => {
      toast({
        title: e ? 'ENDURANCE ON — no time/budget limits' : 'Endurance off — budgets restored',
        description: e
          ? '1000 steps · 24h turns · 1h commands · no rate cap. Kill switch, destructive block and audits remain.'
          : undefined,
        variant: e ? 'destructive' : 'default',
      })
      void useRedline.getState().refreshSystem()
    }
    socket?.on('mode:rejected', onRejected)
    socket?.on('limits:changed', onLimits)
    return () => { socket?.off('mode:rejected', onRejected); socket?.off('limits:changed', onLimits) }
  }, [toast])

  const applyMode = (m: Mode, confirm = false) => {
    const socket = getSocket()
    if (!socket || !socket.connected) {
      toast({
        title: 'AGENT SERVICE UNREACHABLE',
        description: 'Start it in a separate terminal with: bun run service — then retry.',
        variant: 'destructive',
      })
      return
    }
    socket.emit('mode:set', { mode: m, confirm })
    // optimistic local update; socket 'mode:changed' event is the truth
    if (m !== 'unrestricted' || confirm) setMode(m)
  }

  return (
    <>
      <div className="flex flex-col gap-1" role="radiogroup" aria-label="Operating mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="radio"
            aria-checked={mode === m.id}
            title={m.hint}
            onClick={() => (m.id === 'unrestricted' && mode !== 'unrestricted' ? setWarnOpen(true) : applyMode(m.id))}
            className={cn(
              'btn-neon group flex w-full items-center justify-between rounded-sm border px-2.5 py-1.5 text-left',
              mode === m.id
                ? 'border-current/60 bg-muted/60'
                : 'border-border/60 hover:border-primary/40 hover:bg-muted/30',
              m.cls,
              m.id === 'unrestricted' && mode === 'unrestricted' && 'badge-danger-pulse'
            )}
          >
            <span className="flex flex-col">
              <span className="text-[10px] font-bold tracking-[0.22em]">{compact ? m.label : m.label}</span>
              {!compact && <span className="text-[9px] text-muted-foreground">{m.hint}</span>}
            </span>
            <span
              className={cn(
                'h-2 w-2 rounded-full border',
                mode === m.id ? 'border-current bg-current pulse-dot' : 'border-muted-foreground/40'
              )}
            />
          </button>
        ))}
      </div>

      {/* ENDURANCE — unrestricted-only switch: lifts every time/budget guard */}
      {mode === 'unrestricted' && (
        <button
          onClick={() => {
            const socket = getSocket()
            if (!socket || !socket.connected) {
              toast({ title: 'AGENT SERVICE UNREACHABLE', variant: 'destructive' })
              return
            }
            socket.emit('limits:set', { endurance: !endurance })
          }}
          aria-pressed={endurance}
          title="1000 steps · 24h turns · 1h commands · no per-minute rate cap — kill switch, destructive block, no-repeat and audits stay on"
          className={cn(
            'btn-neon mt-1 flex w-full items-center justify-between rounded-sm border px-2.5 py-1.5 text-left text-[var(--neon-amber)]',
            endurance
              ? 'border-[var(--neon-amber)]/70 bg-[var(--neon-amber)]/15 badge-danger-pulse'
              : 'border-[var(--neon-amber)]/30 hover:bg-[var(--neon-amber)]/10'
          )}
        >
          <span className="flex flex-col">
            <span className="text-[10px] font-bold tracking-[0.22em]">ENDURANCE</span>
            <span className="text-[9px] text-muted-foreground">no time / budget limits</span>
          </span>
          <span className={cn('h-2 w-2 rounded-full border', endurance ? 'border-current bg-current pulse-dot' : 'border-muted-foreground/40')} />
        </button>
      )}

      <AlertDialog open={warnOpen} onOpenChange={setWarnOpen}>
        <AlertDialogContent className="cyber-panel cyber-panel-danger rounded-sm border-[var(--neon-red)]/50">
          <AlertDialogHeader>
            <AlertDialogTitle className="neon-red text-sm uppercase tracking-[0.2em]">
              ⚠ UNRESTRICTED MODE — explicit override
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-xs leading-relaxed text-foreground/85">
                <p>
                  You are about to switch OFF two safety layers for the <b>entire platform</b>:
                </p>
                <ul className="ml-4 list-disc space-y-1 text-[var(--neon-red)]">
                  <li><b>No charter check</b> — the agent may run commands against ANY host, not just chartered targets.</li>
                  <li><b>No approval cards</b> — nothing waits for you before it executes.</li>
                </ul>
                <p>
                  What deliberately <b className="neon-green">survives</b>: the destructive-pattern block (protects
                  your machine, no off switch), rate limits, budgets (24 steps / 240s turns / 90s commands), the kill
                  switch, the full audit trail, and the stay-on-task engagement gate.
                </p>
                <p className="text-[var(--neon-amber)]">
                  While on: the badge turns red and a banner runs across every page. This persists across restarts
                  until you switch back.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="btn-neon">STAY SAFE</AlertDialogCancel>
            <AlertDialogAction
              className="btn-neon border border-[var(--neon-red)]/60 bg-[var(--neon-red)]/20 text-[var(--neon-red)] hover:bg-[var(--neon-red)]/30"
              onClick={() => applyMode('unrestricted', true)}
            >
              I UNDERSTAND — OVERRIDE
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function KillSwitchButton() {
  const killSwitch = useRedline((s) => s.system?.killSwitch ?? false)
  const setKillSwitch = useRedline((s) => s.setKillSwitch)
  const sessionId = useRedline((s) => s.sessionId)
  const { toast } = useToast()
  return (
    <button
      onClick={() => {
        const socket = getSocket()
        if (!socket || !socket.connected) {
          toast({
            title: 'AGENT SERVICE UNREACHABLE',
            description: 'Start it in a separate terminal with: bun run service — then retry.',
            variant: 'destructive',
          })
          return
        }
        const nextState = !killSwitch
        socket.emit('kill:toggle', { enabled: nextState, sessionId })
        setKillSwitch(nextState)
        if (nextState) {
          toast({
            title: 'EMERGENCY KILL SWITCH ENGAGED',
            description: 'All running commands and operations are being terminated immediately.',
            variant: 'destructive',
          })
        } else {
          toast({
            title: 'Kill switch cleared',
            description: 'Actions flow again through the guards.',
            variant: 'default',
          })
        }
      }}
      className={cn(
        'btn-neon flex w-full items-center justify-center gap-2 rounded-sm border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.3em] transition-all',
        killSwitch
          ? 'border-[var(--neon-red)] bg-[var(--neon-red)]/25 text-[var(--neon-red)] badge-danger-pulse'
          : 'border-[var(--neon-red)]/40 bg-transparent text-[var(--neon-red)]/80 hover:bg-[var(--neon-red)]/10'
      )}
      aria-pressed={killSwitch}
    >
      <span className={cn('inline-block h-2 w-2 rounded-full bg-current', killSwitch && 'pulse-dot')} />
      {killSwitch ? 'KILL SWITCH: ON' : 'KILL SWITCH'}
    </button>
  )
}

export function UnrestrictedBanner() {
  const mode = useRedline((s) => s.system?.mode ?? 'free')
  const endurance = useRedline((s) => s.system?.endurance ?? false)
  if (mode !== 'unrestricted') return null
  return (
    <div className="danger-banner relative z-20 flex items-center justify-center gap-3 px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--neon-red)]">
      <span className="pulse-dot">●</span>
      unrestricted mode — charter egress &amp; approval cards are off{endurance ? ' · LIMITS OFF (endurance)' : ' · destructive block · rate limits · budgets · kill switch · audit remain'}
      <span className="pulse-dot">●</span>
    </div>
  )
}
