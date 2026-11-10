'use client'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

// ─── cyberpunk primitive kit ─────────────────────────────────────────────────

export function GlitchTitle({ text, className }: { text: string; className?: string }) {
  return (
    <h1
      className={cn('glitch font-bold tracking-[0.18em] uppercase', className)}
      data-text={text}
    >
      {text}
    </h1>
  )
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('text-[10px] uppercase tracking-[0.3em] text-muted-foreground/80', className)}>
      {children}
    </div>
  )
}

export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
  accent,
  danger,
  scan,
}: {
  title?: ReactNode
  right?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  accent?: boolean
  danger?: boolean
  scan?: boolean
}) {
  return (
    <section
      className={cn(
        'cyber-panel',
        accent && 'cyber-panel-accent',
        danger && 'cyber-panel-danger',
        'rounded-sm',
        className
      )}
    >
      {title !== undefined && (
        <header
          className={cn(
            'flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2',
            scan && 'scan-bar'
          )}
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-primary/90">
            {title}
          </div>
          {right}
        </header>
      )}
      <div className={cn('p-3', bodyClassName)}>{children}</div>
    </section>
  )
}

export function StatCard({
  label,
  value,
  sub,
  tone = 'cyan',
  icon,
}: {
  label: string
  value: ReactNode
  sub?: string
  tone?: 'cyan' | 'magenta' | 'acid' | 'green' | 'amber' | 'red'
  icon?: ReactNode
}) {
  const toneCls = {
    cyan: 'text-[var(--neon-cyan)]',
    magenta: 'text-[var(--neon-magenta)]',
    acid: 'text-[var(--neon-acid)]',
    green: 'text-[var(--neon-green)]',
    amber: 'text-[var(--neon-amber)]',
    red: 'text-[var(--neon-red)]',
  }[tone]
  return (
    <div className="cyber-panel rounded-sm p-4 rise-in">
      <div className="flex items-start justify-between">
        <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">{label}</div>
        {icon && <div className={cn('opacity-70', toneCls)}>{icon}</div>}
      </div>
      <div className={cn('mt-2 text-3xl font-bold tabular-nums', toneCls)}>{value}</div>
      {sub && <div className="mt-1 text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  )
}

export function ModeBadge({ mode, pulse }: { mode: string; pulse?: boolean }) {
  const map: Record<string, string> = {
    guarded: 'border-[var(--neon-cyan)]/50 text-[var(--neon-cyan)] bg-[var(--neon-cyan)]/10',
    free: 'border-[var(--neon-green)]/50 text-[var(--neon-green)] bg-[var(--neon-green)]/10',
    unrestricted: 'border-[var(--neon-red)]/70 text-[var(--neon-red)] bg-[var(--neon-red)]/15',
  }
  const label: Record<string, string> = { guarded: 'GUARDED', free: 'FREE TERMINAL', unrestricted: 'UNRESTRICTED' }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.2em]',
        map[mode] ?? map.free,
        mode === 'unrestricted' && pulse !== false && 'badge-danger-pulse'
      )}
    >
      <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {label[mode] ?? mode}
    </span>
  )
}

export function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    critical: 'text-[var(--neon-red)] border-[var(--neon-red)]/60 bg-[var(--neon-red)]/10',
    high: 'text-[var(--neon-magenta)] border-[var(--neon-magenta)]/60 bg-[var(--neon-magenta)]/10',
    medium: 'text-[var(--neon-amber)] border-[var(--neon-amber)]/60 bg-[var(--neon-amber)]/10',
    low: 'text-[var(--neon-cyan)] border-[var(--neon-cyan)]/60 bg-[var(--neon-cyan)]/10',
    info: 'text-muted-foreground border-border bg-muted/40',
  }
  return (
    <span className={cn('rounded-sm border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.18em]', map[severity] ?? map.info)}>
      {severity}
    </span>
  )
}

export function HoneypotBadge({ verdict, score }: { verdict: string; score?: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-[var(--neon-magenta)]/60 bg-[var(--neon-magenta)]/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.18em] text-[var(--neon-magenta)]">
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
        <path d="M12 2a5 5 0 0 0-5 5v4H5v9h14v-9h-2V7a5 5 0 0 0-5-5z" />
      </svg>
      {verdict === 'likely_honeypot' ? 'HONEYPOT' : verdict === 'possible' ? 'SUSPECT' : 'CLEAN'}
      {score !== undefined && <span className="opacity-70">{score}</span>}
    </span>
  )
}

/** capability meter 1-10 */
export function CapBar({ label, value, max = 10, tone = 'cyan' }: { label: string; value: number; max?: number; tone?: 'cyan' | 'magenta' | 'acid' | 'green' | 'amber' }) {
  const pct = Math.round((value / max) * 100)
  const bg = {
    cyan: 'bg-[var(--neon-cyan)] shadow-[0_0_8px_rgba(0,229,255,0.6)]',
    magenta: 'bg-[var(--neon-magenta)] shadow-[0_0_8px_rgba(255,42,109,0.6)]',
    acid: 'bg-[var(--neon-acid)] shadow-[0_0_8px_rgba(249,240,2,0.5)]',
    green: 'bg-[var(--neon-green)] shadow-[0_0_8px_rgba(10,255,157,0.5)]',
    amber: 'bg-[var(--neon-amber)] shadow-[0_0_8px_rgba(255,180,0,0.5)]',
  }[tone]
  return (
    <div className="flex items-center gap-2" title={`${label}: ${value}/${max}`}>
      <span className="w-16 shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-muted/60">
        <div className={cn('h-full rounded-sm transition-all duration-500', bg)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-foreground/80">{value}</span>
    </div>
  )
}

export function Chip({ children, tone = 'muted', className, title }: { children: ReactNode; tone?: 'muted' | 'cyan' | 'magenta' | 'green' | 'acid' | 'red' | 'amber'; className?: string; title?: string }) {
  const map = {
    muted: 'border-border text-muted-foreground bg-muted/30',
    cyan: 'border-[var(--neon-cyan)]/40 text-[var(--neon-cyan)] bg-[var(--neon-cyan)]/10',
    magenta: 'border-[var(--neon-magenta)]/40 text-[var(--neon-magenta)] bg-[var(--neon-magenta)]/10',
    green: 'border-[var(--neon-green)]/40 text-[var(--neon-green)] bg-[var(--neon-green)]/10',
    acid: 'border-[var(--neon-acid)]/40 text-[var(--neon-acid)] bg-[var(--neon-acid)]/10',
    red: 'border-[var(--neon-red)]/40 text-[var(--neon-red)] bg-[var(--neon-red)]/10',
    amber: 'border-[var(--neon-amber)]/40 text-[var(--neon-amber)] bg-[var(--neon-amber)]/10',
  }[tone]
  return (
    <span title={title} className={cn('inline-block rounded-sm border px-1.5 py-0.5 text-[10px]', map, className)}>
      {children}
    </span>
  )
}

export function StatusDot({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px]">
      <span
        className={cn(
          'inline-block h-1.5 w-1.5 rounded-full',
          ok ? 'bg-[var(--neon-green)] shadow-[0_0_6px_rgba(10,255,157,0.8)]' : 'bg-muted-foreground/50'
        )}
      />
      {label && <span className="text-muted-foreground">{label}</span>}
    </span>
  )
}
