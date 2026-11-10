'use client'
import { useEffect, useState } from 'react'
import { useRedline } from '@/lib/redline-store'
import { GlitchTitle, Panel, StatCard, SectionLabel, Chip, ModeBadge, HoneypotBadge, SeverityBadge, StatusDot } from '@/components/cyber/primitives'
import { Button } from '@/components/ui/button'
import { Activity, ShieldAlert, Radar, Bug, Skull, Terminal, Crosshair, Cpu, HardDrive, Network, Wrench, Clock, Gauge } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Finding { id: number; kind: string; title: string; detail: string; severity: string; honeypotScore: number | null; ts: string }
interface AuditRow { id: number; kind: string; mode: string; actor: string; verdict: string | null; detail: string; ts: string }
interface EngRow { id: number; eid: string; target: string; status: string; phase: string; profile: string; _count: { tasks: number; findings: number } }

export default function DashboardView() {
  const { system, setView, refreshSystem } = useRedline()
  const [findings, setFindings] = useState<Finding[]>([])
  const [audit, setAudit] = useState<AuditRow[]>([])
  const [engagements, setEngagements] = useState<EngRow[]>([])

  useEffect(() => {
    let alive = true
    const load = async () => {
      const [f, a, e] = await Promise.all([
        fetch('/api/findings?limit=8', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        fetch('/api/audit?limit=12', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        fetch('/api/engagements', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      ])
      if (!alive) return
      if (f?.findings) setFindings(f.findings)
      if (a?.events) setAudit(a.events)
      if (e?.engagements) setEngagements(e.engagements)
    }
    void load()
    const t = setInterval(load, 8000)
    const t2 = setInterval(() => void refreshSystem(), 15000)
    return () => { alive = false; clearInterval(t); clearInterval(t2) }
  }, [refreshSystem])

  const os = system?.os
  const charter = system?.charter
  const stats = system?.stats
  const toolsAvailable = system?.tools.filter((t) => t.availability === 'available') ?? []
  const toolsMissing = system?.tools.filter((t) => t.availability === 'missing') ?? []

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      {/* hero */}
      <section className="cyber-panel scan-bar relative overflow-hidden rounded-sm p-6 flicker-in">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <SectionLabel>{'// autonomous red team operations'}</SectionLabel>
            <GlitchTitle text="REDLINE" className="mt-1 text-4xl text-[var(--neon-cyan)] md:text-5xl" />
            <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground">
              Recon → enumeration → vulnerability analysis → ladder-gated exploitation → report.
              Charter-scoped guards live <b className="text-foreground">below</b> the AI — no prompt can bypass them.
              The agent knows its OS, its tools, their speeds <i>and</i> their flaws.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 md:items-end">
            <ModeBadge mode={system?.mode ?? 'free'} />
            <div className="flex gap-2">
              <Button size="sm" className="btn-neon border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20" onClick={() => setView('console')}>
                <Terminal className="mr-1 h-3.5 w-3.5" /> Open Console
              </Button>
              <Button size="sm" variant="outline" className="btn-neon border-border hover:bg-muted/50" onClick={() => setView('engagements')}>
                <Crosshair className="mr-1 h-3.5 w-3.5" /> Engage
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Tool actions" value={stats?.actions ?? '—'} tone="cyan" icon={<Activity className="h-4 w-4" />} sub="executed through the 5-step wrapper" />
        <StatCard label="Guard refusals" value={stats?.refusals ?? '—'} tone="magenta" icon={<ShieldAlert className="h-4 w-4" />} sub="evidence the guard worked" />
        <StatCard label="Findings" value={stats?.findings ?? '—'} tone="acid" icon={<Bug className="h-4 w-4" />} sub="recon → exploit evidence" />
        <StatCard label="Honeypot flags" value={stats?.honeypots ?? '—'} tone="magenta" icon={<Skull className="h-4 w-4" />} sub="behavioral detection" />
        <StatCard label="Pending approvals" value={stats?.pendingApprovals ?? '—'} tone="amber" icon={<Clock className="h-4 w-4" />} sub="cards waiting for you" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* system intel */}
        <Panel title="System intel — what the agent sees" scan>
          <div className="space-y-2 text-[11px] leading-relaxed">
            <div className="flex items-start gap-2">
              <Cpu className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--neon-cyan)]" aria-hidden />
              <div>
                <b>Host OS:</b> {os ? `${os.platform} · ${os.release} · ${os.arch}` : '…'}
                <span className="text-muted-foreground"> — hostname {os?.hostname}, user {os?.user}</span>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--neon-green)]" aria-hidden />
              <div>
                <b>WSL:</b>{' '}
                {os?.isWindows
                  ? os.wsl.available
                    ? <span>{os.wsl.distros.join(', ')} — preferred: <b className="text-[var(--neon-green)]">{os.wsl.preferred}</b>{os.wsl.kaliPresent ? ' (Kali detected)' : ''}</span>
                    : 'none — PowerShell fallback (install WSL Kali for the full toolchain)'
                  : <span className="text-muted-foreground">not a Windows host — native bash</span>}
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Network className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--neon-magenta)]" aria-hidden />
              <div>
                <b>Execution:</b> {os?.exec.note ?? '…'}
                <div className="text-muted-foreground">scratch: <code className="text-[10px] text-foreground/80">{os?.exec.scratchRoot}</code></div>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--neon-acid)]" aria-hidden />
              <div>
                <b>Tool board:</b>{' '}
                <span className="text-[var(--neon-green)]">{toolsAvailable.length} ready</span>
                {toolsMissing.length > 0 && <span className="text-muted-foreground"> · {toolsMissing.length} known-but-missing (Marketplace)</span>}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {toolsAvailable.slice(0, 14).map((t) => (
                    <Chip key={t.id} tone={t.builtin ? 'cyan' : 'green'}>{t.name}</Chip>
                  ))}
                  {toolsAvailable.length > 14 && <Chip>+{toolsAvailable.length - 14}</Chip>}
                </div>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Gauge className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--neon-amber)]" aria-hidden />
              <div>
                <b>Budgets:</b> {system ? `${system.budgets.stepsPerTurn} steps/turn · ${system.budgets.turnSeconds}s turns · ${system.budgets.commandSeconds}s commands` : '…'}
                <span className="text-muted-foreground"> · no-repeat guard armed</span>
              </div>
            </div>
          </div>
        </Panel>

        {/* charter snapshot */}
        <Panel title="Charter — the written authorization" right={<Button size="sm" variant="outline" className="btn-neon h-6 border-border px-2 text-[9px]" onClick={() => setView('targets')}>MANAGE</Button>}>
          <div className="space-y-2 text-[11px]">
            <div>
              <SectionLabel>Authorized hosts</SectionLabel>
              <div className="mt-1 flex flex-wrap gap-1">
                {(charter?.hosts ?? []).map((h) => <Chip key={h} tone="cyan">{h}</Chip>)}
                {!charter?.hosts?.length && <Chip>none — add targets first</Chip>}
              </div>
            </div>
            <div>
              <SectionLabel>Authorized networks</SectionLabel>
              <div className="mt-1 flex flex-wrap gap-1">
                {(charter?.networks ?? []).map((n) => <Chip key={n} tone="green">{n}</Chip>)}
              </div>
            </div>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Two-sided check (name + resolved IP), loaded fresh for every action. The AI can never edit it —
              <code className="text-foreground/80"> python charter_add.py add &lt;host&gt; --detect</code> is operator-only.
            </p>
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* recent findings */}
        <Panel title="Latest findings" className="lg:col-span-2" bodyClassName="p-0">
          <div className="max-h-72 overflow-y-auto term-scroll">
            {findings.length === 0 && <div className="p-4 text-[11px] text-muted-foreground">No findings yet — run an engagement or chat the console.</div>}
            {findings.map((f) => (
              <div key={f.id} className="flex items-start gap-2 border-b border-border/40 px-3 py-2 last:border-0">
                <SeverityBadge severity={f.severity} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] text-foreground/90">{f.title}</div>
                  <div className="truncate text-[10px] text-muted-foreground">{f.detail.slice(0, 120)}</div>
                </div>
                {f.kind === 'honeypot' && <HoneypotBadge verdict="likely_honeypot" score={f.honeypotScore ?? undefined} />}
              </div>
            ))}
          </div>
        </Panel>

        {/* engagements mini */}
        <Panel title="Engagements" bodyClassName="p-0">
          <div className="max-h-72 overflow-y-auto term-scroll">
            {engagements.length === 0 && <div className="p-4 text-[11px] text-muted-foreground">No engagements yet.</div>}
            {engagements.slice(0, 6).map((e) => (
              <button key={e.id} onClick={() => setView('engagements')} className="w-full border-b border-border/40 px-3 py-2 text-left last:border-0 hover:bg-muted/30">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-[var(--neon-cyan)]">{e.eid}</span>
                  <Chip tone={e.status === 'running' ? 'green' : e.status === 'done' ? 'cyan' : e.status === 'aborted' ? 'red' : 'muted'}>{e.status}</Chip>
                </div>
                <div className="text-[10px] text-muted-foreground">{e.target} · {e._count.tasks} tasks · {e._count.findings} findings · {e.profile}</div>
              </button>
            ))}
          </div>
        </Panel>
      </div>

      {/* audit stream */}
      <Panel title="Guard activity — live audit" right={<Button size="sm" variant="outline" className="btn-neon h-6 border-border px-2 text-[9px]" onClick={() => setView('audit')}>FULL LOG</Button>} bodyClassName="p-0">
        <div className="max-h-64 overflow-y-auto term-scroll">
          {audit.map((a) => {
            const d = (() => { try { return JSON.parse(a.detail) } catch { return {} } })()
            return (
              <div key={a.id} className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-[10px] last:border-0">
                <span className="tabular-nums text-muted-foreground/60">{new Date(a.ts).toLocaleTimeString()}</span>
                <Chip tone={a.verdict === 'allowed' ? 'green' : a.verdict === 'refused' || a.verdict === 'blocked' ? 'red' : 'muted'}>{a.kind}</Chip>
                <span className="truncate text-muted-foreground">
                  {d.reason ?? d.command ?? d.host ?? d.tool ?? d.action ?? a.actor}
                </span>
              </div>
            )
          })}
        </div>
      </Panel>
    </div>
  )
}
