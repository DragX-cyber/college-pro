'use client'
import { useEffect, useMemo, useState } from 'react'
import { GlitchTitle, Panel, SectionLabel, Chip } from '@/components/cyber/primitives'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import { Copy, Swords, AlertTriangle, Radio } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Kind {
  id: string
  group: 'payload' | 'packet' | 'sniff' | 'handler'
  label: string
  description: string
  fields: { key: string; label: string; placeholder?: string }[]
}

interface Item {
  id: string
  title: string
  output: string
  notes: string
  caveats?: string
  handler?: string
}

const GROUPS: { id: Kind['group']; label: string; tone: string }[] = [
  { id: 'payload', label: 'PAYLOADS', tone: 'text-[var(--neon-red)]' },
  { id: 'packet', label: 'PACKET CRAFT', tone: 'text-[var(--neon-cyan)]' },
  { id: 'sniff', label: 'SNIFF & ANALYZE', tone: 'text-[var(--neon-green)]' },
  { id: 'handler', label: 'LISTENERS', tone: 'text-[var(--neon-amber)]' },
]

export default function ArsenalView() {
  const { toast } = useToast()
  const [kinds, setKinds] = useState<Kind[]>([])
  const [selected, setSelected] = useState<Kind | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [item, setItem] = useState<Item | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/arsenal', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setKinds(d.kinds ?? []))
      .catch(() => {})
  }, [])

  const grouped = useMemo(
    () => GROUPS.map((g) => ({ ...g, kinds: kinds.filter((k) => k.group === g.id) })),
    [kinds]
  )

  const pick = (k: Kind) => {
    setSelected(k)
    setItem(null)
    setFields(Object.fromEntries(k.fields.map((f) => [f.key, ''])))
  }

  const generate = async () => {
    if (!selected) return
    setBusy(true)
    const r = await fetch('/api/arsenal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: selected.id, ...fields }),
    })
      .then((x) => x.json())
      .catch(() => null)
    setBusy(false)
    if (r?.ok) setItem(r.item)
    else toast({ title: 'Generation failed', description: r?.error, variant: 'destructive' })
  }

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => toast({ title: `${what} copied` }),
      () => toast({ title: 'Copy failed — select manually', variant: 'destructive' })
    )
  }

  const labOnly = selected?.id.includes('flood')

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <GlitchTitle text="ARSENAL" className="text-lg text-[var(--neon-red)]" />
          <SectionLabel>payloads · packet craft · sniffing — generated, never auto-executed; every command still passes the guard chain</SectionLabel>
        </div>
        <Chip tone="red">{kinds.length} generators</Chip>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* left: catalog */}
        <div className="space-y-3">
          {grouped.map((g) => (
            <Panel key={g.id} title={<span className={g.tone}>{g.label}</span>} bodyClassName="p-1.5">
              <div className="space-y-1">
                {g.kinds.map((k) => (
                  <button
                    key={k.id}
                    onClick={() => pick(k)}
                    title={k.description}
                    className={cn(
                      'w-full rounded-sm border px-2.5 py-1.5 text-left transition-colors',
                      selected?.id === k.id
                        ? 'border-[var(--neon-red)]/50 bg-[var(--neon-red)]/10'
                        : 'border-transparent hover:border-border hover:bg-muted/30'
                    )}
                  >
                    <div className="text-[11px] font-semibold text-foreground">{k.label}</div>
                    <div className="truncate text-[9px] text-muted-foreground">{k.description}</div>
                  </button>
                ))}
              </div>
            </Panel>
          ))}
        </div>

        {/* right: generator */}
        <div className="space-y-3">
          {!selected && (
            <Panel title="Pick a generator" scan>
              <div className="flex items-center gap-3 p-4 text-[11px] text-muted-foreground">
                <Swords className="h-6 w-6 text-[var(--neon-red)]/50" aria-hidden />
                Pick a payload, packet or sniffing generator on the left — fill LHOST/LPORT (or target/file), generate, copy.
                The agent has the same power via its generate_payload action.
              </div>
            </Panel>
          )}
          {selected && (
            <Panel title={selected.label} scan>
              {labOnly && (
                <div className="mb-3 flex items-start gap-2 rounded-sm border border-[var(--neon-red)]/50 bg-[var(--neon-red)]/10 p-2.5 text-[10px] leading-relaxed text-[var(--neon-red)]">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  LAB ONLY — denial-of-service test. Never point at anything outside your own lab charter. Authorization is on you.
                </div>
              )}
              {selected.fields.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {selected.fields.map((f) => (
                    <div key={f.key}>
                      <div className="mb-1 text-[9px] uppercase tracking-[0.2em] text-muted-foreground">{f.label}</div>
                      <Input
                        value={fields[f.key] ?? ''}
                        onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                        className="btn-neon border-border bg-black/40 text-[11px]"
                      />
                    </div>
                  ))}
                </div>
              )}
              <Button
                size="sm"
                disabled={busy}
                onClick={generate}
                className="btn-neon mt-3 h-8 border border-[var(--neon-red)]/50 bg-[var(--neon-red)]/15 px-4 text-[10px] text-[var(--neon-red)] hover:bg-[var(--neon-red)]/25"
              >
                <Swords className="mr-1.5 h-3.5 w-3.5" aria-hidden />{busy ? 'generating…' : 'GENERATE'}
              </Button>

              {item && (
                <div className="mt-4 space-y-3">
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[9px] uppercase tracking-[0.2em] text-[var(--neon-cyan)]">{item.title}</span>
                      <Button size="sm" variant="outline" onClick={() => copy(item.output, 'Payload')} className="btn-neon h-6 border-border px-2 text-[9px]">
                        <Copy className="mr-1 h-3 w-3" aria-hidden />copy
                      </Button>
                    </div>
                    <pre className="term-scroll max-h-56 overflow-auto rounded-sm border border-border/60 bg-black/50 p-2.5 font-mono text-[10.5px] leading-relaxed text-[var(--neon-green)] whitespace-pre-wrap break-all">{item.output}</pre>
                  </div>
                  {item.handler && (
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.2em] text-[var(--neon-amber)]">
                          <Radio className="h-3 w-3" aria-hidden />run this handler FIRST
                        </span>
                        <Button size="sm" variant="outline" onClick={() => copy(item.handler!, 'Handler')} className="btn-neon h-6 border-border px-2 text-[9px]">
                          <Copy className="mr-1 h-3 w-3" aria-hidden />copy
                        </Button>
                      </div>
                      <pre className="term-scroll overflow-auto rounded-sm border border-[var(--neon-amber)]/30 bg-black/50 p-2.5 font-mono text-[10.5px] leading-relaxed text-[var(--neon-amber)] whitespace-pre-wrap break-all">{item.handler}</pre>
                    </div>
                  )}
                  <p className="text-[10px] leading-relaxed text-muted-foreground">{item.notes}</p>
                  {item.caveats && (
                    <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-[var(--neon-amber)]">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />{item.caveats}
                    </p>
                  )}
                </div>
              )}
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}
