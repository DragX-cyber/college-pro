'use client'
import { useCallback, useEffect, useState } from 'react'
import { useRedline } from '@/lib/redline-store'
import { getSocket } from '@/lib/socket'
import { GlitchTitle, Panel, Chip, SeverityBadge, HoneypotBadge, SectionLabel } from '@/components/cyber/primitives'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Plus, Play, Square, FileDown, Crosshair } from 'lucide-react'

const PHASES = [
  { id: 'recon', label: 'RECON' },
  { id: 'enumeration', label: 'ENUMERATE' },
  { id: 'vuln_analysis', label: 'VULN ANALYSIS' },
  { id: 'exploitation', label: 'EXPLOITATION' },
  { id: 'post_exploit', label: 'POST-EXPLOIT' },
  { id: 'reporting', label: 'REPORT' },
]

const DOMAINS = [
  { id: 'network', label: 'Network & Services' },
  { id: 'web', label: 'Web Apps' },
  { id: 'dirs', label: 'Directories' },
  { id: 'dns', label: 'DNS & Subdomains' },
  { id: 'tls', label: 'TLS/SSL' },
  { id: 'smb', label: 'SMB' },
  { id: 'ad', label: 'Active Directory' },
  { id: 'snmp', label: 'SNMP' },
  { id: 'vuln', label: 'Vuln Surface' },
]

interface Task { id: number; title: string; phase: string; domain: string; parallelGroup: number; status: string; summary: string | null; output: string | null; footprint: number | null; toolHint: string | null }
interface Finding { id: number; kind: string; title: string; detail: string; severity: string; honeypotScore: number | null }
interface Engagement { id: number; eid: string; target: string; objective: string; profile: string; status: string; phase: string; runner: string; createdAt: string; tasks: Task[]; findings: Finding[] }

export default function EngagementsView() {
  const { system } = useRedline()
  const { toast } = useToast()
  const [list, setList] = useState<any[]>([])
  const [selected, setSelected] = useState<Engagement | null>(null)
  const [report, setReport] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ target: '', objective: 'full attack-surface assessment, low footprint', profile: 'balanced', domains: ['network', 'web', 'dns', 'vuln'] as string[] })

  const loadList = useCallback(async () => {
    const r = await fetch('/api/engagements', { cache: 'no-store' }).then((x) => x.json()).catch(() => null)
    if (r?.engagements) setList(r.engagements)
  }, [])

  const loadDetail = useCallback(async (id: number) => {
    const r = await fetch(`/api/engagements/${id}`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null)
    if (r?.engagement) setSelected(r.engagement)
    return r?.engagement
  }, [])

  useEffect(() => {
    queueMicrotask(() => { void loadList() })
    const socket = getSocket()
    const onUpdate = () => { queueMicrotask(() => { void loadList(); if (selected) void loadDetail(selected.id) }) }
    socket?.on('engagement:updated', onUpdate)
    socket?.on('engagement:started', onUpdate)
    return () => { socket?.off('engagement:updated', onUpdate); socket?.off('engagement:started', onUpdate) }
  }, [loadList, loadDetail, selected])

  // poll while an engagement is running
  const running = selected?.status === 'running'
  useEffect(() => {
    if (!selected || !running) return
    const t = setInterval(() => { queueMicrotask(() => { void loadDetail(selected.id); void loadList() }) }, 2500)
    return () => clearInterval(t)
  }, [selected, running, loadDetail, loadList])

  const create = async () => {
    if (!form.target.trim()) return
    const socket = getSocket()
    socket?.emit('engagement:create', {
      target: form.target.trim(),
      objective: form.objective,
      profile: form.profile,
      domains: form.domains,
    }, async (r: any) => {
      if (r?.ok) {
        toast({ title: `Engagement ${r.engagement.eid} planned`, description: `${r.engagement.tasks?.length ?? ''} tasks across the kill chain — review and run.` })
        setCreateOpen(false)
        await loadList()
        await loadDetail(r.engagement.id)
      } else {
        toast({ title: 'Target refused', description: r?.error ?? 'charter check failed', variant: 'destructive' })
      }
    })
  }

  const run = (id: number, runner: 'heuristic' | 'agent') => {
    const socket = getSocket()
    socket?.emit('engagement:run', { id, runner }, (r: any) => {
      if (r?.ok) { toast({ title: runner === 'agent' ? 'Agent runner started' : 'Deterministic runner started', description: 'Every action still passes the guards — watch the Audit page.' }) }
      else toast({ title: 'Cannot run', description: r?.error ?? 'already running', variant: 'destructive' })
    })
  }

  const stop = (id: number) => {
    getSocket()?.emit('engagement:stop', { id })
  }

  const fetchReport = async (id: number) => {
    const r = await fetch(`/api/engagements/${id}/report`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null)
    if (r?.report) setReport(r.report)
  }

  const exportReport = () => {
    if (!report || !selected) return
    const blob = new Blob([report], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selected.eid}-report.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const statusTone = (s: string) =>
    s === 'done' ? 'green' : s === 'running' ? 'cyan' : s === 'failed' ? 'red' : s === 'refused' ? 'magenta' : s === 'tool_unavailable' ? 'amber' : s === 'skipped' ? 'muted' : 'muted'

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <GlitchTitle text="ENGAGEMENTS" className="text-lg text-[var(--neon-cyan)]" />
          <SectionLabel>operator-gated · a failed chat task can never escalate itself into one</SectionLabel>
        </div>
        <Button className="btn-neon border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> New engagement
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        {/* list */}
        <Panel title="Operations" bodyClassName="p-0">
          <div className="term-scroll max-h-[70vh] overflow-y-auto">
            {list.length === 0 && <div className="p-4 text-[11px] text-muted-foreground">No engagements yet — plan the first one.</div>}
            {list.map((e) => (
              <button
                key={e.id}
                onClick={() => { setSelected(null); void loadDetail(e.id); setReport(null) }}
                className={cn(
                  'w-full border-b border-border/40 px-3 py-2.5 text-left last:border-0 hover:bg-muted/30',
                  selected?.id === e.id && 'bg-primary/10'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-[var(--neon-cyan)]">{e.eid}</span>
                  <Chip tone={statusTone(e.status)}>{e.status}{e.status === 'running' ? '…' : ''}</Chip>
                </div>
                <div className="text-[10px] text-muted-foreground">{e.target} · {e.profile} · {e._count.tasks} tasks · {e._count.findings} findings</div>
              </button>
            ))}
          </div>
        </Panel>

        {/* detail */}
        {selected ? (
          <div className="space-y-3">
            <Panel
              title={`${selected.eid} — ${selected.target}`}
              right={
                <div className="flex gap-1.5">
                  {selected.status !== 'running' ? (
                    <>
                      <Button size="sm" className="btn-neon h-7 border border-[var(--neon-green)]/50 bg-[var(--neon-green)]/10 text-[var(--neon-green)] hover:bg-[var(--neon-green)]/20" onClick={() => run(selected.id, 'heuristic')}>
                        <Play className="mr-1 h-3 w-3" /> RUN
                      </Button>
                      <Button size="sm" variant="outline" className="btn-neon h-7 border-border hover:bg-muted/50" onClick={() => run(selected.id, 'agent')} title="LLM-driven execution, task by task">
                        <Play className="mr-1 h-3 w-3" /> AGENT
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" className="btn-neon h-7 border-[var(--neon-red)]/50 text-[var(--neon-red)]" onClick={() => stop(selected.id)}>
                      <Square className="mr-1 h-3 w-3" /> STOP
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="btn-neon h-7 border-border hover:bg-muted/50" onClick={() => void fetchReport(selected.id)}>
                    <FileDown className="mr-1 h-3 w-3" /> REPORT
                  </Button>
                </div>
              }
            >
              {/* kill chain rail */}
              <div className="mb-3 flex flex-wrap items-center gap-1">
                {PHASES.map((p, i) => {
                  const phaseTasks = selected.tasks.filter((t) => t.phase === p.id)
                  const done = phaseTasks.length > 0 && phaseTasks.every((t) => ['done', 'skipped', 'tool_unavailable', 'refused'].includes(t.status))
                  const active = selected.phase === p.id && selected.status === 'running'
                  return (
                    <div key={p.id} className="flex items-center gap-1">
                      <div
                        className={cn(
                          'rounded-sm border px-2 py-1 text-[9px] font-bold uppercase tracking-[0.15em]',
                          active ? 'border-[var(--neon-cyan)] bg-[var(--neon-cyan)]/15 text-[var(--neon-cyan)] pulse-dot' :
                          done ? 'border-[var(--neon-green)]/60 bg-[var(--neon-green)]/10 text-[var(--neon-green)]' :
                          'border-border/60 text-muted-foreground'
                        )}
                      >
                        {p.label}
                      </div>
                      {i < PHASES.length - 1 && <div className="h-px w-3 bg-border/70" />}
                    </div>
                  )
                })}
              </div>

              <div className="mb-3 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                <Chip tone="cyan">objective: {selected.objective}</Chip>
                <Chip>profile: {selected.profile}</Chip>
                <Chip>runner: {selected.runner}</Chip>
                <Chip>status: {selected.status}</Chip>
              </div>

              {/* tasks by phase */}
              <div className="space-y-2.5">
                {PHASES.map((p) => {
                  const tasks = selected.tasks.filter((t) => t.phase === p.id)
                  if (!tasks.length) return null
                  const groups = Array.from(new Set(tasks.map((t) => t.parallelGroup))).sort((a, b) => a - b)
                  return (
                    <div key={p.id}>
                      <div className="mb-1 text-[9px] uppercase tracking-[0.28em] text-muted-foreground">{p.label}</div>
                      {groups.map((g) => (
                        <div key={g} className="mb-1.5 rounded-sm border border-border/40 bg-black/20 p-2" title="tasks in one lane are independent — raise charter concurrency to parallelize">
                          <div className="mb-1 text-[9px] text-muted-foreground/70">lane {g + 1} {groups.length > 1 ? '(parallelizable)' : ''}</div>
                          {tasks.filter((t) => t.parallelGroup === g).map((t) => (
                            <details key={t.id} className="group rounded-sm border border-border/30 bg-muted/10 px-2 py-1.5">
                              <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px]">
                                <Chip tone={statusTone(t.status) as any}>{t.status}</Chip>
                                <span className="min-w-0 flex-1 truncate text-foreground/90">{t.title}</span>
                                {t.footprint && <Chip tone={t.footprint >= 4 ? 'red' : t.footprint >= 3 ? 'amber' : 'green'} title="footprint 1-5">fp {t.footprint}</Chip>}
                                {t.toolHint && <Chip>{t.toolHint}</Chip>}
                              </summary>
                              <div className="mt-2 space-y-1.5">
                                {t.summary && <div className="text-[10px] text-muted-foreground">{t.summary}</div>}
                                {t.output && (
                                  <pre className="term-scroll max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border/40 bg-black/40 p-2 text-[10px] leading-relaxed text-foreground/75">{t.output}</pre>
                                )}
                              </div>
                            </details>
                          ))}
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            </Panel>

            {report && (
              <Panel
                title="Engagement report"
                right={<Button size="sm" variant="outline" className="btn-neon h-6 border-border px-2 text-[9px]" onClick={exportReport}>EXPORT .MD</Button>}
              >
                <pre className="term-scroll max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-sm border border-border/40 bg-black/30 p-3 text-[10.5px] leading-relaxed text-foreground/85">{report}</pre>
              </Panel>
            )}

            {selected.findings.length > 0 && (
              <Panel title={`Findings (${selected.findings.length})`} bodyClassName="p-0">
                <div className="term-scroll max-h-72 overflow-y-auto">
                  {selected.findings.map((f) => (
                    <div key={f.id} className="flex items-start gap-2 border-b border-border/40 px-3 py-2 last:border-0">
                      <SeverityBadge severity={f.severity} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] text-foreground/90">{f.title}</div>
                        <div className="truncate text-[10px] text-muted-foreground">{f.detail.slice(0, 160)}</div>
                      </div>
                      {f.kind === 'honeypot' && <HoneypotBadge verdict="likely_honeypot" score={f.honeypotScore ?? undefined} />}
                    </div>
                  ))}
                </div>
              </Panel>
            )}
          </div>
        ) : (
          <Panel>
            <div className="flex flex-col items-center gap-3 p-10 text-center text-muted-foreground">
              <Crosshair className="h-8 w-8 text-[var(--neon-cyan)]/50" aria-hidden />
              <p className="text-[11px] leading-relaxed">
                Select an operation, or plan a new one. The plan covers the full kill chain with parallel lanes,
                ladder-gated exploitation, honeypot heuristics and footprint accounting — run it deterministically or
                through the agent.
              </p>
            </div>
          </Panel>
        )}
      </div>

      {/* create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="cyber-panel rounded-sm border-border">
          <DialogHeader>
            <DialogTitle className="text-sm uppercase tracking-[0.2em] text-primary">Plan engagement</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-[11px]">
            <div>
              <Label className="text-muted-foreground">Target (must be chartered)</Label>
              <Select value={form.target} onValueChange={(v) => setForm((f) => ({ ...f, target: v }))}>
                <SelectTrigger className="btn-neon mt-1 border-border bg-black/40"><SelectValue placeholder="pick a chartered host" /></SelectTrigger>
                <SelectContent className="border-border bg-popover">
                  {(system?.charter?.hosts ?? []).map((h) => (
                    <SelectItem key={h} value={h}>{h}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {system?.charter?.hosts?.length === 0 && <p className="mt-1 text-[var(--neon-amber)]">No chartered hosts — add one on the Targets page first.</p>}
            </div>
            <div>
              <Label className="text-muted-foreground">Objective</Label>
              <Input value={form.objective} onChange={(e) => setForm((f) => ({ ...f, objective: e.target.value }))} className="btn-neon mt-1 border-border bg-black/40 text-[11px]" />
            </div>
            <div>
              <Label className="text-muted-foreground">Profile</Label>
              <Select value={form.profile} onValueChange={(v) => setForm((f) => ({ ...f, profile: v }))}>
                <SelectTrigger className="btn-neon mt-1 border-border bg-black/40"><SelectValue /></SelectTrigger>
                <SelectContent className="border-border bg-popover">
                  <SelectItem value="stealth">stealth — passive-first, capped rates, quiet tools</SelectItem>
                  <SelectItem value="balanced">balanced — default trade-off</SelectItem>
                  <SelectItem value="fast">fast — masscan-first, speed over stealth</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-muted-foreground">Domains to cover</Label>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {DOMAINS.map((d) => {
                  const on = form.domains.includes(d.id)
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, domains: on ? f.domains.filter((x) => x !== d.id) : [...f.domains, d.id] }))}
                      className={cn(
                        'btn-neon rounded-sm border px-2 py-1 text-[10px]',
                        on ? 'border-primary/60 bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-muted/40'
                      )}
                    >
                      {d.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="btn-neon border-border" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button className="btn-neon border border-primary/50 bg-primary/15 text-primary hover:bg-primary/25" onClick={() => void create()} disabled={!form.target}>
              <Crosshair className="mr-1 h-3.5 w-3.5" /> Plan it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
