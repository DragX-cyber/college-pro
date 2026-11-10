'use client'
import { useEffect, useState } from 'react'
import { useRedline } from '@/lib/redline-store'
import { GlitchTitle, Panel, SectionLabel, Chip } from '@/components/cyber/primitives'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { useToast } from '@/hooks/use-toast'
import { ShieldAlert, Radar, Plus, Trash2, Lock } from 'lucide-react'

export default function TargetsView() {
  const { refreshSystem } = useRedline()
  const { toast } = useToast()
  const [charter, setCharter] = useState<any>(null)
  const [newHost, setNewHost] = useState('')
  const [detect, setDetect] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const r = await fetch('/api/charter', { cache: 'no-store' }).then((x) => x.json()).catch(() => null)
    if (r?.charter) setCharter(r.charter)
  }

  useEffect(() => { queueMicrotask(() => { void load() }) }, [])

  const addHost = async () => {
    if (!newHost.trim()) return
    setBusy(true)
    const r = await fetch('/api/charter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', host: newHost.trim(), detect }),
    }).then((x) => x.json()).catch(() => null)
    setBusy(false)
    if (r?.ok) {
      toast({
        title: r.added ? `Chartered: ${newHost.trim()}` : `${newHost.trim()} was already chartered`,
        description: [
          r.ips?.length ? `resolves → ${r.ips.join(', ')}` : 'no DNS — two-sided check will refuse until hosts_map is set',
          r.findings?.length ? `detect: ${r.findings.join(' · ')}` : '',
        ].filter(Boolean).join(' | ') || undefined,
      })
      setNewHost('')
      setCharter(r.charter)
      void refreshSystem()
    } else {
      toast({ title: 'Refused', description: r?.error ?? 'invalid host', variant: 'destructive' })
    }
  }

  const removeHost = async (host: string) => {
    const r = await fetch('/api/charter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', host }),
    }).then((x) => x.json()).catch(() => null)
    if (r?.ok) { setCharter(r.charter); void refreshSystem(); toast({ title: `Removed ${host}` }) }
  }

  const updateRoe = async (patch: Record<string, number>) => {
    const r = await fetch('/api/charter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'roe', ...patch }),
    }).then((x) => x.json()).catch(() => null)
    if (r?.ok) { setCharter(r.charter); void refreshSystem() }
  }

  const roe = charter?.rules ?? {}
  const exploitation = charter?.exploitation ?? {}
  const deception = charter?.deception ?? {}

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <GlitchTitle text="TARGETS / CHARTER" className="text-lg text-[var(--neon-cyan)]" />
          <SectionLabel>the single source of authorization — loaded fresh for every action</SectionLabel>
        </div>
        <Chip tone="amber" className="flex items-center gap-1"><Lock className="h-3 w-3" /> operator-only — the AI can never edit this</Chip>
      </div>

      <Panel title="Authorized hosts" accent>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-52 flex-1">
            <Label className="text-[10px] text-muted-foreground">host / IP / URL</Label>
            <Input
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addHost()}
              placeholder="pentest-ground.com  ·  178.79.134.182"
              className="btn-neon mt-1 border-border bg-black/40 text-[11px]"
            />
          </div>
          <div className="flex items-center gap-2 pb-1.5">
            <Switch checked={detect} onCheckedChange={setDetect} id="detect" />
            <Label htmlFor="detect" className="text-[10px] text-muted-foreground">Add + detect</Label>
          </div>
          <Button className="btn-neon border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20" disabled={busy || !newHost.trim()} onClick={() => void addHost()}>
            <Plus className="mr-1 h-3.5 w-3.5" /> ADD
          </Button>
        </div>

        <div className="mt-3 space-y-1.5">
          {(charter?.hosts ?? []).map((h: string) => (
            <div key={h} className="flex items-center gap-2 rounded-sm border border-border/40 bg-black/20 px-2.5 py-1.5">
              <Radar className="h-3.5 w-3.5 text-[var(--neon-cyan)]" aria-hidden />
              <span className="text-[12px] text-foreground">{h}</span>
              {charter.hosts_map?.[h] && (
                <span className="text-[10px] text-muted-foreground">→ {charter.hosts_map[h].join(', ')}</span>
              )}
              <Button size="sm" variant="ghost" className="ml-auto h-6 w-6 p-0 text-muted-foreground hover:text-[var(--neon-red)]" onClick={() => void removeHost(h)} aria-label={`remove ${h}`}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          {!charter?.hosts?.length && <div className="text-[11px] text-muted-foreground">No hosts chartered. The two-sided check refuses everything except loopback.</div>}
        </div>
        <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
          Equivalent CLI: <code className="text-foreground/80">python charter_add.py add &lt;host&gt; --detect</code> — adds the host, resolves it into
          hosts_map, and registers its /32 (or /128) networks so the two-sided check passes.
        </p>
      </Panel>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Authorized networks">
          <div className="flex flex-wrap gap-1.5">
            {(charter?.networks ?? []).map((n: string) => <Chip key={n} tone="green">{n}</Chip>)}
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
            Name side AND IP side must both pass: a chartered hostname whose DNS drifted outside these networks is
            refused; an unchartered name resolving INTO them is allowed (the operator authorized that IP).
          </p>
        </Panel>

        <Panel title="Rules of engagement">
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>max concurrent actions</span><span className="text-primary tabular-nums">{roe.max_concurrent_actions}</span>
              </div>
              <Slider min={1} max={8} step={1} value={[roe.max_concurrent_actions ?? 1]} onValueChange={([v]) => void updateRoe({ max_concurrent_actions: v })} className="mt-1" />
            </div>
            <div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>rate limit / minute</span><span className="text-primary tabular-nums">{roe.rate_limit_per_minute}</span>
              </div>
              <Slider min={5} max={120} step={5} value={[roe.rate_limit_per_minute ?? 30]} onValueChange={([v]) => void updateRoe({ rate_limit_per_minute: v })} className="mt-1" />
            </div>
            <div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>time budget (min)</span><span className="text-primary tabular-nums">{roe.time_budget_minutes}</span>
              </div>
              <Slider min={15} max={240} step={15} value={[roe.time_budget_minutes ?? 90]} onValueChange={([v]) => void updateRoe({ time_budget_minutes: v })} className="mt-1" />
            </div>
            <div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>exploit ladder max rung (1-5)</span><span className="text-primary tabular-nums">{exploitation.max_rung}</span>
              </div>
              <Slider min={1} max={5} step={1} value={[exploitation.max_rung ?? 3]} onValueChange={([v]) => void updateRoe({ max_rung: v })} className="mt-1" />
              <p className="mt-1 text-[9px] text-muted-foreground/70">rungs 4-5 additionally require exploitation.replica_host in the yaml</p>
            </div>
            <div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>honeypot threshold</span><span className="text-primary tabular-nums">{deception.honeypot_threshold}</span>
              </div>
              <Slider min={20} max={100} step={5} value={[deception.honeypot_threshold ?? 60]} onValueChange={([v]) => void updateRoe({ honeypot_threshold: v })} className="mt-1" />
            </div>
            <div className="rounded-sm border border-[var(--neon-red)]/40 bg-[var(--neon-red)]/5 px-2.5 py-2 text-[10px] text-[var(--neon-red)]">
              <ShieldAlert className="mr-1 inline h-3 w-3" />
              destructive_actions: <b>forbidden</b> — immutable from the UI, like the real RoE you signed.
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="Static hosts map">
        {Object.keys(charter?.hosts_map ?? {}).length === 0 ? (
          <div className="text-[11px] text-muted-foreground">Empty — added hosts with DNS land here automatically.</div>
        ) : (
          <div className="space-y-1">
            {Object.entries(charter.hosts_map).map(([host, ips]: [string, any]) => (
              <div key={host} className="flex items-center gap-2 rounded-sm border border-border/40 bg-black/20 px-2.5 py-1.5 text-[11px]">
                <span className="text-foreground">{host}</span>
                <span className="text-muted-foreground">→ {(ips as string[]).join(', ')}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}
