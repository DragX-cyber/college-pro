'use client'
import { useEffect, useMemo, useState } from 'react'
import { GlitchTitle, Panel, SectionLabel, Chip, CapBar } from '@/components/cyber/primitives'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { getSocket } from '@/lib/socket'
import { cn } from '@/lib/utils'
import { Search, Download, Trash2, Zap, ScanSearch } from 'lucide-react'

const CATEGORIES: Record<string, string> = {
  core: 'CORE', network: 'NETWORK', web: 'WEB', dns: 'DNS', ssl: 'TLS',
  smb: 'SMB', ad: 'AD', snmp: 'SNMP', exploit: 'EXPLOIT', creds: 'CREDS', recon: 'RECON',
}

export default function MarketView() {
  const { toast } = useToast()
  const [tools, setTools] = useState<any[]>([])
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [comparison, setComparison] = useState<any>(null)
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const [compareTask, setCompareTask] = useState('port_scan')
  const [busy, setBusy] = useState<string | null>(null)

  const load = async (task?: string) => {
    const url = task ? `/api/marketplace?compare=${task}` : '/api/marketplace'
    const r = await fetch(url, { cache: 'no-store' }).then((x) => x.json()).catch(() => null)
    if (!r) return
    setTools(r.tools ?? [])
    setLabels(r.taskLabels ?? {})
    if (r.comparison) setComparison(r.comparison)
  }

  useEffect(() => { queueMicrotask(() => { void load('port_scan') }) }, [])

  const install = (id: string, name: string, systemInstall: boolean) => {
    setBusy(id)
    getSocket()?.emit('market:install', { id, systemInstall }, (r: any) => {
      setBusy(null)
      if (r?.ok) {
        toast({
          title: `${name} registered`,
          description: `The agent's tool board now includes ${name} — purpose, usage, capability scores, pros and flaws — from the next action.${systemInstall && r.systemInstallOutput ? ` System install: ${String(r.systemInstallOutput).slice(0, 120)}` : ''}`,
        })
        void load(compareTask)
      } else toast({ title: 'Install failed', description: r?.error, variant: 'destructive' })
    })
  }

  const uninstall = (id: string) => {
    setBusy(id)
    getSocket()?.emit('market:uninstall', { id }, () => { setBusy(null); void load(compareTask) })
  }

  const autodetect = () => {
    setBusy('autodetect')
    getSocket()?.emit('market:autodetect', {}, (r: any) => {
      setBusy(null)
      if (!r) { toast({ title: 'Autodetect failed', description: 'agent service unreachable', variant: 'destructive' }); return }
      toast({
        title: `Autodetect: ${r.available.length} / ${r.scanned} tools found`,
        description: r.registered.length
          ? `Newly registered: ${r.registered.join(', ')} — the agent knows them from the next action.`
          : 'Tool board already up to date.',
      })
      void load(compareTask)
    })
  }

  const filtered = useMemo(
    () => tools.filter((t) =>
      (cat === 'all' || t.category === cat) &&
      (!q || `${t.name} ${t.tagline} ${t.purpose}`.toLowerCase().includes(q.toLowerCase()))
    ),
    [tools, q, cat]
  )

  const installedCount = tools.filter((t) => t.installed).length

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <GlitchTitle text="TOOL MARKET" className="text-lg text-[var(--neon-cyan)]" />
          <SectionLabel>capability-aware installs — the agent learns purpose, usage, speed AND flaws automatically</SectionLabel>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone="green">{installedCount} / {tools.length} registered</Chip>
          <Button size="sm" disabled={busy === 'autodetect'} className="btn-neon h-7 border border-primary/50 bg-primary/15 px-3 text-[9px] text-primary hover:bg-primary/25" onClick={autodetect}>
            <ScanSearch className="mr-1 h-3 w-3" aria-hidden />
            {busy === 'autodetect' ? 'scanning…' : 'auto-detect installed'}
          </Button>
        </div>
      </div>

      {/* compare panel — the nmap vs masscan story */}
      <Panel title="Smart selection — how the agent picks" scan>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56">
            <div className="text-[10px] text-muted-foreground">compare a task across priorities</div>
            <Select value={compareTask} onValueChange={(v) => { setCompareTask(v); void load(v) }}>
              <SelectTrigger className="btn-neon mt-1 border-border bg-black/40 text-[11px]"><SelectValue /></SelectTrigger>
              <SelectContent className="border-border bg-popover">
                {Object.entries(labels).map(([id, label]) => (
                  <SelectItem key={id} value={id} className="text-[11px]">{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {comparison && (
            <div className="flex flex-1 flex-wrap gap-2">
              {Object.entries(comparison.strategies).map(([priority, s]: [string, any]) => (
                <div key={priority} className="min-w-40 flex-1 rounded-sm border border-border/50 bg-black/25 p-2">
                  <div className="text-[9px] uppercase tracking-[0.25em] text-muted-foreground">{priority}</div>
                  <div className="mt-1 text-[11px] text-[var(--neon-green)]">→ {s.primary?.name ?? '—'}</div>
                  <div className="mt-0.5 text-[9.5px] leading-relaxed text-muted-foreground">
                    {s.ranked.slice(0, 3).map((c: any, i: number) => (
                      <div key={c.id}>{i + 1}. {c.name} <span className="tabular-nums opacity-70">{c.score}</span></div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {comparison?.strategies?.speed?.complement && (
          <p className="mt-2 text-[10px] leading-relaxed text-[var(--neon-cyan)]/90">
            <Zap className="mr-1 inline h-3 w-3" />
            {comparison.strategies.speed.complement.note.slice(0, 300)}
          </p>
        )}
      </Panel>

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search tools…" className="btn-neon border-border bg-black/40 pl-8 text-[11px]" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setCat('all')} className={cn('btn-neon rounded-sm border px-2 py-1 text-[10px]', cat === 'all' ? 'border-primary/60 bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-muted/40')}>ALL</button>
          {Object.entries(CATEGORIES).map(([id, label]) => (
            <button key={id} onClick={() => setCat(id)} className={cn('btn-neon rounded-sm border px-2 py-1 text-[10px]', cat === id ? 'border-primary/60 bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-muted/40')}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* tool grid */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((t) => {
          const topCaps = Object.entries(t.capabilities ?? {}).slice(0, 3)
          return (
            <div key={t.id} className={cn('cyber-panel flex flex-col rounded-sm p-3 rise-in', t.installed && 'border-[var(--neon-green)]/30')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-bold text-foreground">{t.name}</span>
                    <Chip tone={t.availability === 'available' ? 'green' : t.availability === 'missing' ? 'red' : 'muted'}>
                      {t.availability === 'available' ? '● BIN READY' : t.availability === 'missing' ? '○ BIN MISSING' : '· UNKNOWN'}
                    </Chip>
                  </div>
                  <div className="text-[10px] text-[var(--neon-cyan)]/80">{t.tagline}</div>
                </div>
                <Chip tone={t.category === 'exploit' || t.category === 'creds' ? 'magenta' : 'muted'}>{CATEGORIES[t.category] ?? t.category}</Chip>
              </div>

              <p className="mt-2 line-clamp-3 text-[10.5px] leading-relaxed text-muted-foreground">{t.purpose}</p>

              {topCaps.length > 0 && (
                <div className="mt-2 space-y-1">
                  {topCaps.map(([task, c]: [string, any]) => (
                    <div key={task} title={labels[task] ?? task}>
                      <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
                        <span>{(labels[task] ?? task).slice(0, 22)}</span>
                        <span className="tabular-nums">spd {c.speed} · eff {c.efficiency} · cov {c.coverage} · rel {c.reliability}</span>
                      </div>
                      <CapBar label="" value={Math.round((c.speed + c.efficiency + c.coverage + c.reliability) / 4)} tone={c.speed >= 8 ? 'acid' : 'cyan'} />
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-2 flex flex-wrap gap-1">
                {t.pros.slice(0, 2).map((p: string) => <Chip key={p} tone="green" title={p}>+ {p.slice(0, 28)}{p.length > 28 ? '…' : ''}</Chip>)}
                {t.flaws.slice(0, 2).map((f: any) => <Chip key={f.context} tone="red" title={`${f.context} — ${f.note}`}>− {f.context.slice(0, 24)}</Chip>)}
              </div>

              <div className="mt-auto flex items-center gap-1.5 pt-3">
                {t.installed ? (
                  <>
                    <Chip tone="green">REGISTERED — agent sees it</Chip>
                    <Button size="sm" variant="outline" disabled={busy === t.id} className="btn-neon ml-auto h-7 border-border px-2 text-[9px] hover:text-[var(--neon-red)]" onClick={() => uninstall(t.id)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      className="btn-neon h-7 border border-primary/50 bg-primary/10 px-2 text-[9px] text-primary hover:bg-primary/20"
                      disabled={busy === t.id}
                      onClick={() => install(t.id, t.name, false)}
                    >
                      <Download className="mr-1 h-3 w-3" /> REGISTER
                    </Button>
                    {t.install?.wsl && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === t.id}
                        className="btn-neon h-7 border-border px-2 text-[9px] hover:bg-muted/50"
                        title={`also run: ${t.install.wsl} inside the red-team shell (operator action)`}
                        onClick={() => install(t.id, t.name, true)}
                      >
                        + SYSTEM INSTALL
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
