'use client'
import { useCallback, useEffect, useState } from 'react'
import { GlitchTitle, Panel, SectionLabel, Chip } from '@/components/cyber/primitives'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { Search, Plus, Trash2, RefreshCw, Globe, FileUp, Sparkles, BookOpen } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Entry {
  id: number
  kind: string
  tool: string | null
  title: string
  content: string
  tags: string[]
  source: string
  enabled: boolean
  score?: number
}

const KINDS = ['tool_usage', 'command_syntax', 'mistake', 'planning'] as const
const KIND_TONE: Record<string, string> = {
  tool_usage: 'text-[var(--neon-cyan)]',
  command_syntax: 'text-[var(--neon-green)]',
  mistake: 'text-[var(--neon-red)]',
  planning: 'text-[var(--neon-amber)]',
}

const EMPTY_FORM = { id: 0, kind: 'tool_usage', tool: '', title: '', content: '', tags: '' }

export default function KnowledgeView() {
  const { toast } = useToast()
  const [entries, setEntries] = useState<Entry[]>([])
  const [q, setQ] = useState('')
  const [kindFilter, setKindFilter] = useState('all')
  const [form, setForm] = useState(EMPTY_FORM)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [embedded, setEmbedded] = useState<{ indexed: number; total: number } | null>(null)

  const load = useCallback(async (query = '') => {
    const url = query ? `/api/knowledge?q=${encodeURIComponent(query)}` : '/api/knowledge'
    const r = await fetch(url, { cache: 'no-store' }).then((x) => x.json()).catch(() => null)
    if (r) {
      setEntries(r.entries ?? [])
      if (r.embedded) setEmbedded(r.embedded)
    }
  }, [])

  useEffect(() => { queueMicrotask(() => { void load() }) }, [load])

  const search = () => { void load(q) }

  const save = async () => {
    if (!form.title.trim() || !form.content.trim()) {
      toast({ title: 'Title and content are required', variant: 'destructive' }); return
    }
    setBusy('save')
    const payload = {
      kind: form.kind,
      tool: form.tool.trim() || null,
      title: form.title,
      content: form.content,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
    }
    const url = form.id ? `/api/knowledge/${form.id}` : '/api/knowledge'
    const r = await fetch(url, {
      method: form.id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((x) => x.json()).catch(() => null)
    setBusy(null)
    if (r?.ok) {
      toast({ title: form.id ? 'Entry updated' : 'Entry added', description: 'The agent picks it up on its next turn.' })
      setForm(EMPTY_FORM); setShowForm(false); void load(q)
    } else toast({ title: 'Save failed', description: r?.error, variant: 'destructive' })
  }

  const del = async (id: number) => {
    setBusy(`del-${id}`)
    const r = await fetch(`/api/knowledge/${id}`, { method: 'DELETE' }).then((x) => x.json()).catch(() => null)
    setBusy(null)
    if (r?.ok) void load(q)
    else toast({ title: 'Delete failed', variant: 'destructive' })
  }

  const reseed = async () => {
    setBusy('seed')
    const r = await fetch('/api/knowledge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'seed' }),
    }).then((x) => x.json()).catch(() => null)
    setBusy(null)
    if (r?.ok) { toast({ title: `Seed pack restored (${r.inserted} entries)` }); void load(q) }
    else toast({ title: 'Seed failed', variant: 'destructive' })
  }

  const ingestDocs = async () => {
    setBusy('docs')
    const r = await fetch('/api/knowledge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'ingest_docs' }),
    }).then((x) => x.json()).catch(() => null)
    setBusy(null)
    if (r?.ok) {
      toast({
        title: `Online docs ingested for ${r.ingested.length} tools`,
        description: r.ingested.length ? r.ingested.join(', ') : 'No tldr pages found for the installed tools.',
      })
      void load(q)
    } else toast({ title: 'Docs ingest failed', variant: 'destructive' })
  }

  const reindex = async () => {
    setBusy('reindex')
    const r = await fetch('/api/knowledge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reindex', force: true }),
    }).then((x) => x.json()).catch(() => null)
    setBusy(null)
    if (r?.ok) {
      toast({
        title: r.skipped ? 'Vector search disabled' : `Embedded ${r.indexed} entries (${r.total} total)`,
        description: r.skipped ? 'Set the embedding server URL in Settings (a dedicated embedder on :8081).' : 'Semantic search is now active on new lookups.',
      })
      void load(q)
    } else toast({ title: 'Reindex failed — is the embedder running on :8081?', variant: 'destructive' })
  }

  const importFile = async (f: File) => {
    setBusy('import')
    const fd = new FormData()
    fd.append('file', f)
    const r = await fetch('/api/knowledge/import', { method: 'POST', body: fd })
      .then((x) => x.json()).catch(() => null)
    setBusy(null)
    if (r?.ok) {
      toast({
        title: `Imported ${r.entries.length} entries from ${f.name}`,
        description: `AI-converted: ${[...new Set(r.entries.map((e: Entry) => e.kind))].join(', ')}${r.detail ? ` · ${r.detail}` : ''}`,
      })
      void load(q)
    } else {
      toast({ title: 'Import failed', description: r?.error ?? 'upload failed', variant: 'destructive' })
    }
  }

  const edit = (e: Entry) => {
    setForm({ id: e.id, kind: e.kind, tool: e.tool ?? '', title: e.title, content: e.content, tags: e.tags.join(', ') })
    setShowForm(true)
  }

  const filtered = entries.filter((e) => kindFilter === 'all' || e.kind === kindFilter)
  const counts = KINDS.map((k) => ({ k, n: entries.filter((e) => e.kind === k).length }))

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <GlitchTitle text="KNOWLEDGE BASE" className="text-lg text-[var(--neon-cyan)]" />
          <SectionLabel>retrieved into the agent&apos;s prompt — curated expertise + lessons it learned from its own failures</SectionLabel>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone="green">{entries.length} entries</Chip>
          {embedded && embedded.total > 0 && (
            <Chip tone={embedded.indexed >= embedded.total ? 'cyan' : 'amber'}>vector {embedded.indexed}/{embedded.total}</Chip>
          )}
          <Button size="sm" disabled={busy === 'seed'} onClick={reseed} className="btn-neon h-7 border border-border px-3 text-[9px]" title="restore the curated seed pack (replaces seed entries, keeps yours)">
            <RefreshCw className="mr-1 h-3 w-3" aria-hidden />{busy === 'seed' ? 'seeding…' : 're-seed'}
          </Button>
          <Button size="sm" disabled={busy === 'docs'} onClick={ingestDocs} className="btn-neon h-7 border border-border px-3 text-[9px]" title="fetch command docs for installed tools from tldr-pages (online)">
            <Globe className="mr-1 h-3 w-3" aria-hidden />{busy === 'docs' ? 'fetching…' : 'fetch online docs'}
          </Button>
          <Button size="sm" disabled={busy === 'reindex'} onClick={reindex} className="btn-neon h-7 border border-border px-3 text-[9px]" title="embed all entries via the dedicated embedder (:8081) for semantic search">
            <Sparkles className="mr-1 h-3 w-3" aria-hidden />{busy === 'reindex' ? 'embedding…' : 'vector reindex'}
          </Button>
          <label
            className={cn(
              'btn-neon inline-flex h-7 cursor-pointer items-center rounded-sm border border-border px-3 text-[9px]',
              busy === 'import' ? 'opacity-60' : 'hover:bg-muted/30'
            )}
            title="upload a PDF / DOCX / CSV / TXT / MD file — the AI converts it into knowledge-base entries"
          >
            <FileUp className="mr-1 h-3 w-3" aria-hidden />
            {busy === 'import' ? 'converting…' : 'import doc'}
            <input
              type="file"
              accept=".pdf,.docx,.csv,.txt,.md,.json,.log,text/*"
              className="hidden"
              disabled={busy === 'import'}
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = '' // allow re-selecting the same file
                if (f) void importFile(f)
              }}
            />
          </label>
          <Button size="sm" onClick={() => { setForm(EMPTY_FORM); setShowForm((v) => !v) }} className="btn-neon h-7 border border-primary/50 bg-primary/15 px-3 text-[9px] text-primary hover:bg-primary/25">
            <Plus className="mr-1 h-3 w-3" aria-hidden />add entry
          </Button>
        </div>
      </div>

      {showForm && (
        <Panel title={form.id ? `Edit entry #${form.id}` : 'New knowledge entry'} scan>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-[0.2em] text-muted-foreground">kind</div>
              <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v }))}>
                <SelectTrigger className="btn-neon border-border bg-black/40 text-[11px]"><SelectValue /></SelectTrigger>
                <SelectContent className="border-border bg-popover">
                  {KINDS.map((k) => <SelectItem key={k} value={k} className="text-[11px]">{k}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-[0.2em] text-muted-foreground">tool (binary name, optional)</div>
              <Input value={form.tool} onChange={(e) => setForm((f) => ({ ...f, tool: e.target.value }))} placeholder="nmap, curl, …" className="btn-neon border-border bg-black/40 text-[11px]" />
            </div>
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-[0.2em] text-muted-foreground">tags (comma separated)</div>
              <Input value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} placeholder="port_scan, recon" className="btn-neon border-border bg-black/40 text-[11px]" />
            </div>
          </div>
          <div className="mt-3">
            <div className="mb-1 text-[9px] uppercase tracking-[0.2em] text-muted-foreground">title</div>
            <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="nmap needs -Pn for filtered hosts" className="btn-neon border-border bg-black/40 text-[11px]" />
          </div>
          <div className="mt-3">
            <div className="mb-1 text-[9px] uppercase tracking-[0.2em] text-muted-foreground">content (what the agent should know / do)</div>
            <Textarea value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))} rows={3} placeholder="Keep it short and imperative — this goes straight into its prompt." className="btn-neon resize-none border-border bg-black/40 text-[11px]" />
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" disabled={busy === 'save'} onClick={save} className="btn-neon h-7 border border-primary/50 bg-primary/15 px-4 text-[9px] text-primary hover:bg-primary/25">{busy === 'save' ? 'saving…' : 'save'}</Button>
            <Button size="sm" variant="outline" onClick={() => { setShowForm(false); setForm(EMPTY_FORM) }} className="btn-neon h-7 border-border px-4 text-[9px]">cancel</Button>
          </div>
        </Panel>
      )}

      <Panel title="Entries" bodyClassName="p-0" scan>
        <div className="flex flex-wrap items-center gap-2 border-b border-border/50 p-3">
          <div className="relative min-w-56 flex-1">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="search what the agent will retrieve…" className="btn-neon h-8 border-border bg-black/40 pl-7 text-[11px]" />
          </div>
          <Button size="sm" onClick={search} className="btn-neon h-8 border border-primary/50 bg-primary/15 px-3 text-[9px] text-primary hover:bg-primary/25">search</Button>
          <Select value={kindFilter} onValueChange={setKindFilter}>
            <SelectTrigger className="btn-neon h-8 w-36 border-border bg-black/40 text-[10px]"><SelectValue /></SelectTrigger>
            <SelectContent className="border-border bg-popover">
              <SelectItem value="all" className="text-[10px]">all kinds</SelectItem>
              {KINDS.map((k) => <SelectItem key={k} value={k} className="text-[10px]">{k}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-1.5 px-3 py-2">
          {counts.map(({ k, n }) => (
            <button key={k} onClick={() => setKindFilter(kindFilter === k ? 'all' : k)} className={cn('text-[9px] uppercase tracking-wider', KIND_TONE[k], kindFilter === k && 'underline underline-offset-4')}>{k} ({n})</button>
          ))}
        </div>
        <div className="max-h-[52vh] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="p-6 text-center text-[11px] text-muted-foreground">
              <BookOpen className="mx-auto mb-2 h-5 w-5 opacity-40" aria-hidden />
              {entries.length === 0 ? 'No entries yet — add one or hit re-seed.' : 'No matches for this filter/search.'}
            </div>
          )}
          {filtered.map((e) => (
            <div key={e.id} className={cn('group flex items-start gap-3 border-b border-border/40 px-3 py-2.5', !e.enabled && 'opacity-40')}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('text-[9px] font-bold uppercase tracking-wider', KIND_TONE[e.kind])}>{e.kind}</span>
                  {e.tool && <span className="rounded-sm border border-border/60 px-1 text-[9px] text-foreground/80">{e.tool}</span>}
                  <span className="text-[11px] font-semibold text-foreground">{e.title}</span>
                  {e.source !== 'operator' && (
                    <span className={cn('text-[8px] uppercase tracking-wider', e.source === 'autolearn' ? 'text-[var(--neon-red)]/80' : 'text-muted-foreground/60')}>{e.source}</span>
                  )}
                  {e.score !== undefined && <span className="text-[9px] text-muted-foreground">score {e.score}</span>}
                </div>
                <div className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">{e.content}</div>
                {e.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">{e.tags.map((t) => <span key={t} className="text-[8px] text-muted-foreground/60">#{t}</span>)}</div>
                )}
              </div>
              <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <Button size="sm" variant="outline" onClick={() => edit(e)} className="btn-neon h-6 border-border px-2 text-[9px]">edit</Button>
                <Button size="sm" variant="outline" disabled={busy === `del-${e.id}`} onClick={() => del(e.id)} className="btn-neon h-6 border-border px-2 text-[9px] hover:text-[var(--neon-red)]"><Trash2 className="h-3 w-3" aria-hidden /></Button>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}
