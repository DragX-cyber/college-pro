'use client'
import { useEffect, useState } from 'react'
import { GlitchTitle, Panel, SectionLabel, Chip } from '@/components/cyber/primitives'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { useRedline } from '@/lib/redline-store'
import { Cpu, Save } from 'lucide-react'

export default function SettingsView() {
  const { toast } = useToast()
  const { refreshSystem } = useRedline()
  const [providers, setProviders] = useState<any[]>([])
  const [form, setForm] = useState<any>(null)

  useEffect(() => {
    fetch('/api/settings', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { setProviders(d.providers ?? []); setForm(d.settings) })
      .catch(() => {})
  }, [])

  if (!form) {
    return <div className="p-4 text-[11px] text-muted-foreground">loading settings…</div>
  }

  const providerInfo = providers.find((p) => p.id === form.provider)

  const save = async () => {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: form.provider,
        thinkingLevel: form.thinkingLevel,
        model: form.model,
        baseUrl: form.baseUrl,
        embeddingBaseUrl: form.embeddingBaseUrl ?? '',
        apiKey: form.apiKey?.startsWith('••') ? undefined : form.apiKey,
        budgets: form.budgets,
        autoApproveClosedSet: form.autoApproveClosedSet,
        autoApproveNonReadOnly: form.autoApproveNonReadOnly,
        knowledgeEnabled: form.knowledgeEnabled,
        ragEnabled: form.ragEnabled,
        vectorEnabled: form.vectorEnabled,
      }),
    }).then((x) => x.json()).catch(() => null)
    if (r?.ok) {
      setForm(r.settings)
      toast({ title: 'Settings saved', description: `provider: ${r.settings.provider} · model: ${r.settings.model || '(default)'}` })
      void refreshSystem()
    } else toast({ title: 'Save failed', variant: 'destructive' })
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div>
        <GlitchTitle text="SETTINGS" className="text-lg text-[var(--neon-cyan)]" />
        <SectionLabel>local models, API keys, budgets, and the approval seat</SectionLabel>
      </div>

      <Panel title="Model backend — local or API key">
        <div className="space-y-3">
          <div>
            <Label className="text-[10px] text-muted-foreground">provider</Label>
            <Select
              value={form.provider}
              onValueChange={(v) => {
                const info = providers.find((p) => p.id === v)
                setForm((f: any) => ({ ...f, provider: v, model: info?.defaultModel ?? '', baseUrl: info?.defaultBaseUrl ?? '' }))
              }}
            >
              <SelectTrigger className="btn-neon mt-1 border-border bg-black/40 text-[11px]"><SelectValue /></SelectTrigger>
              <SelectContent className="border-border bg-popover">
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-[11px]">
                    {p.label} {p.local ? '· local' : p.needsKey ? '· key' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {providerInfo && <p className="mt-1 text-[10px] text-muted-foreground">{providerInfo.description}</p>}
          </div>

          <div>
            <Label className="text-[10px] text-muted-foreground">thinking level (deliberation depth)</Label>
            <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {[
                { id: 'low', label: 'LOW', tag: 'Fast & Concise', desc: '1-line thought. Conserves tokens on 6GB VRAM.' },
                { id: 'medium', label: 'MEDIUM', tag: 'Balanced', desc: '3-point check: [GOAL] | [EVIDENCE] | [DECISION].' },
                { id: 'high', label: 'HIGH', tag: 'Deep Analysis', desc: '4-step strategic analysis: [OBJECTIVE] | [SURFACE] | [HYPOTHESIS] | [DECISION].' },
              ].map((lvl) => (
                <button
                  key={lvl.id}
                  type="button"
                  onClick={() => setForm((f: any) => ({ ...f, thinkingLevel: lvl.id }))}
                  className={cn(
                    'flex flex-col items-start rounded-sm border p-2.5 text-left transition-all',
                    form.thinkingLevel === lvl.id
                      ? lvl.id === 'low'
                        ? 'border-[var(--neon-cyan)]/70 bg-[var(--neon-cyan)]/10 text-[var(--neon-cyan)] shadow-[0_0_8px_rgba(0,229,255,0.2)]'
                        : lvl.id === 'medium'
                          ? 'border-[var(--neon-acid)]/70 bg-[var(--neon-acid)]/10 text-[var(--neon-acid)] shadow-[0_0_8px_rgba(249,240,2,0.2)]'
                          : 'border-[var(--neon-magenta)]/70 bg-[var(--neon-magenta)]/10 text-[var(--neon-magenta)] shadow-[0_0_8px_rgba(255,42,109,0.2)]'
                      : 'border-border/60 bg-black/30 text-muted-foreground hover:border-border hover:text-foreground'
                  )}
                >
                  <div className="flex w-full items-center justify-between">
                    <span className="text-[11px] font-bold tracking-wider">{lvl.label}</span>
                    <span className="text-[9px] opacity-75">{lvl.tag}</span>
                  </div>
                  <span className="mt-1 text-[9.5px] leading-tight opacity-80">{lvl.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label className="text-[10px] text-muted-foreground">model</Label>
              <Input value={form.model ?? ''} onChange={(e) => setForm((f: any) => ({ ...f, model: e.target.value }))} placeholder={providerInfo?.defaultModel || 'provider default'} className="btn-neon mt-1 border-border bg-black/40 text-[11px]" />
            </div>
            <div>
              <Label className="text-[10px] text-muted-foreground">base URL {providerInfo?.local ? '(local server)' : ''}</Label>
              <Input value={form.baseUrl ?? ''} onChange={(e) => setForm((f: any) => ({ ...f, baseUrl: e.target.value }))} placeholder={providerInfo?.defaultBaseUrl || '—'} className="btn-neon mt-1 border-border bg-black/40 text-[11px]" />
            </div>
            <div>
              <Label className="text-[10px] text-muted-foreground">embedding server (vector knowledge search)</Label>
              <Input value={form.embeddingBaseUrl ?? ''} onChange={(e) => setForm((f: any) => ({ ...f, embeddingBaseUrl: e.target.value }))} placeholder="http://localhost:8081/v1 — empty disables" className="btn-neon mt-1 border-border bg-black/40 text-[11px]" />
              <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
                dedicated embedder: <code className="text-foreground/80">llama-server -m nomic-embed-text-v1.5.Q8_0.gguf --embedding --pooling cls -c 8192 --port 8081</code> — hybrid semantic+keyword search degrades to keyword when it&apos;s off.
              </p>
            </div>
          </div>

          <div>
            <Label className="text-[10px] text-muted-foreground">API key {form.hasApiKey ? '· set (stored server-side, never echoed)' : ''}</Label>
            <Input type="password" value={form.apiKey ?? ''} onChange={(e) => setForm((f: any) => ({ ...f, apiKey: e.target.value }))} placeholder={form.hasApiKey ? '•••••••• (leave to keep)' : providerInfo?.needsKey ? 'required' : 'not needed for local models'} className="btn-neon mt-1 border-border bg-black/40 text-[11px]" />
          </div>

          <div className="rounded-sm border border-border/50 bg-black/25 p-2.5 text-[10px] leading-relaxed text-muted-foreground">
            <Cpu className="mr-1 inline h-3 w-3 text-[var(--neon-cyan)]" />
            Ollama: run <code className="text-foreground/80">ollama serve</code>, pull a model, pick it above.
            LM Studio: start the local server. llama.cpp: run <code className="text-foreground/80">llama-server -m model.gguf --host 0.0.0.0</code> and pick llama.cpp above (default port 8080, model name is ignored).
            vLLM/other gateways: pick OpenAI-compatible and set the base URL.
            Windows+WSL note: local endpoints from inside WSL reach the host at <code className="text-foreground/80">http://host.docker.internal</code> or your LAN IP.
          </div>
        </div>
      </Panel>

      <Panel title="Knowledge system — base, RAG, vector DB">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-sm border border-border/50 bg-black/25 px-3 py-2.5">
            <div>
              <div className="text-[11px] text-foreground">Knowledge base (master)</div>
              <div className="text-[10px] text-muted-foreground">OFF = the agent gets zero knowledge: no prompt context, no get_knowledge, no command hints, no autolearning. Your own entries are kept, just not served.</div>
            </div>
            <Switch checked={form.knowledgeEnabled} onCheckedChange={(v) => setForm((f: any) => ({ ...f, knowledgeEnabled: v }))} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-sm border border-border/50 bg-black/25 px-3 py-2.5">
            <div>
              <div className="text-[11px] text-foreground">RAG retrieval</div>
              <div className="text-[10px] text-muted-foreground">Turn-start planning context, the agentic get_knowledge action, per-command hints. Needs the master switch ON; the Knowledge page keeps working for browsing either way.</div>
            </div>
            <Switch checked={form.ragEnabled} onCheckedChange={(v) => setForm((f: any) => ({ ...f, ragEnabled: v }))} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-sm border border-border/50 bg-black/25 px-3 py-2.5">
            <div>
              <div className="text-[11px] text-foreground">Vector DB (semantic search)</div>
              <div className="text-[10px] text-muted-foreground">Hybrid semantic+keyword ranking via the dedicated embedder. OFF = keyword-only retrieval and no new embeddings; stored vectors are kept and reused when switched back on.</div>
            </div>
            <Switch checked={form.vectorEnabled} onCheckedChange={(v) => setForm((f: any) => ({ ...f, vectorEnabled: v }))} />
          </div>
          <div className="rounded-sm border border-border/50 bg-black/25 p-2.5 text-[10px] text-muted-foreground">
            Scope note: whatever is ON, the agent only ever retrieves knowledge about tools this project knows — builtin and marketplace-installed tools — plus the platform&apos;s own planning entries. Everything else stays visible on the Knowledge page for you, but never reaches the model.
          </div>
        </div>
      </Panel>

      <Panel title="Budgets & guardrails">
        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>steps per turn</span><span className="text-primary tabular-nums">{form.budgets.stepsPerTurn}</span>
            </div>
            <Slider min={3} max={48} step={1} value={[form.budgets.stepsPerTurn]} onValueChange={([v]) => setForm((f: any) => ({ ...f, budgets: { ...f.budgets, stepsPerTurn: v } }))} className="mt-1" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>turn time (seconds)</span><span className="text-primary tabular-nums">{form.budgets.turnSeconds}</span>
            </div>
            <Slider min={30} max={900} step={10} value={[form.budgets.turnSeconds]} onValueChange={([v]) => setForm((f: any) => ({ ...f, budgets: { ...f.budgets, turnSeconds: v } }))} className="mt-1" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>per-command timeout (seconds)</span><span className="text-primary tabular-nums">{form.budgets.commandSeconds}</span>
            </div>
            <Slider min={5} max={300} step={5} value={[form.budgets.commandSeconds]} onValueChange={([v]) => setForm((f: any) => ({ ...f, budgets: { ...f.budgets, commandSeconds: v } }))} className="mt-1" />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-sm border border-border/50 bg-black/25 px-3 py-2.5">
            <div>
              <div className="text-[11px] text-foreground">GUARDED approval seat</div>
              <div className="text-[10px] text-muted-foreground">OFF = every closed-set check waits for you (spec-faithful). ON = trust the deterministic set.</div>
            </div>
            <Switch checked={form.autoApproveClosedSet} onCheckedChange={(v) => setForm((f: any) => ({ ...f, autoApproveClosedSet: v }))} />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-sm border border-border/50 bg-black/25 px-3 py-2.5">
            <div>
              <div className="text-[11px] text-foreground">FREE: auto-approve non-read-only commands</div>
              <div className="text-[10px] text-muted-foreground">Convenience override — approval cards still fire in audit. UNRESTRICTED ignores this entirely (no cards by design).</div>
            </div>
            <Switch checked={form.autoApproveNonReadOnly} onCheckedChange={(v) => setForm((f: any) => ({ ...f, autoApproveNonReadOnly: v }))} />
          </div>
        </div>
      </Panel>

      <div className="flex items-center justify-between gap-3">
        <Chip tone="amber">charter RoE (rate limit / concurrency / ladder) lives on the Targets page</Chip>
        <Button className="btn-neon border border-primary/50 bg-primary/15 text-primary hover:bg-primary/25" onClick={() => void save()}>
          <Save className="mr-1 h-3.5 w-3.5" /> SAVE SETTINGS
        </Button>
      </div>
    </div>
  )
}
