// ─────────────────────────────────────────────────────────────────────────────
// Knowledge embeddings — semantic search over the knowledge base via a
// dedicated local embedder (llama-server --embedding on :8081, e.g.
// nomic-embed-text-v1.5). Vectors live in SQLite as JSON float arrays;
// brute-force cosine over a few hundred entries is microseconds, so no
// vector-index dependency is needed.
//
// Retrieval stays HYBRID and degrades gracefully: if the embedder is down or
// entries aren't indexed yet, searchKnowledge silently falls back to the
// keyword scorer — the agent never loses its knowledge base.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from './db'
import { getSettings, getKnowledgeFlags } from './settings'
import { invalidateKnowledgeCache } from './knowledge'

const DEFAULT_EMBED_URL = 'http://localhost:8081/v1'
const EMBED_MODEL = 'nomic-embed-text-v1.5'
const BATCH = 16
const MIN_COVERAGE = 0.6 // fraction of entries that must be embedded before vectors participate in scoring

// nomic-embed task prefixes (ignored harmlessly by other embedders)
export const DOC_PREFIX = 'search_document: '
export const QUERY_PREFIX = 'search_query: '

/** Embedding server base URL; '' disables vector search. */
export async function getEmbeddingBaseUrl(): Promise<string> {
  const s = await getSettings()
  return (s.embeddingBaseUrl ?? DEFAULT_EMBED_URL).trim()
}

/** Batch POST /embeddings — returns null on ANY failure (caller falls back). */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (!texts.length) return []
  // Vector DB master switch: OFF = no embedding requests at all. Every vector
  // path (search, indexing, health probe) flows through this call, so this one
  // gate disables the entire vector DB while keyword search stays intact.
  if (!(await getKnowledgeFlags()).vector) return null
  const base = await getEmbeddingBaseUrl()
  if (!base) return null
  try {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH)
      const res = await fetch(`${base.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: slice }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) return null
      const json: any = await res.json()
      const vecs = (json?.data ?? []) as { embedding?: number[] }[]
      if (vecs.length !== slice.length) return null
      for (const v of vecs) {
        if (!Array.isArray(v.embedding) || !v.embedding.length) return null
        out.push(v.embedding)
      }
    }
    return out
  } catch {
    return null // embedder down / timeout / malformed — caller degrades
  }
}

// ─── vector math ─────────────────────────────────────────────────────────────

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d === 0 ? 0 : dot / d
}

// ─── vector cache (invalidated with the knowledge cache) ─────────────────────

interface VecEntry { entryId: number; dims: number; vec: number[] }
let vecCache: { at: number; rows: VecEntry[] } | null = null
const VEC_TTL = 30_000

export function invalidateVectorCache() { vecCache = null }

async function loadVectors(): Promise<VecEntry[]> {
  if (vecCache && Date.now() - vecCache.at < VEC_TTL) return vecCache.rows
  const rows = await db.knowledgeEmbedding.findMany()
  const out: VecEntry[] = []
  for (const r of rows) {
    try {
      const v = JSON.parse(r.vector)
      if (Array.isArray(v) && v.length) out.push({ entryId: r.entryId, dims: r.dims, vec: v })
    } catch { /* corrupt row — skip */ }
  }
  vecCache = { at: Date.now(), rows: out }
  return out
}

/** Embed one query and cosine-rank the indexed entries. null → not available. */
export async function vectorSearch(query: string, limit = 8): Promise<Map<number, number> | null> {
  const [qvec, vectors] = await Promise.all([embedTexts([QUERY_PREFIX + query]), loadVectors()])
  if (!qvec || !vectors.length) return null
  const q = qvec[0]
  const scored = vectors
    .filter((v) => v.dims === q.length)
    .map((v) => ({ entryId: v.entryId, score: cosine(q, v.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return new Map(scored.map((s) => [s.entryId, s.score]))
}

/** Fraction of the given entry ids that have vectors (coverage gate). */
export async function vectorCoverage(entryIds: number[]): Promise<number> {
  if (!entryIds.length) return 0
  const vectors = await loadVectors()
  const have = new Set(vectors.map((v) => v.entryId))
  return entryIds.filter((id) => have.has(id)).length / entryIds.length
}

// ─── indexing ────────────────────────────────────────────────────────────────

function docText(e: { kind: string; tool: string | null; title: string; content: string; tags: string[] }): string {
  return DOC_PREFIX + [e.tool, e.kind, e.title, e.tags.join(' '), e.content].filter(Boolean).join(' — ').slice(0, 1500)
}

/** Fire-and-forget single-entry embed used by write paths. */
export function embedEntry(entry: { id: number; kind: string; tool: string | null; title: string; content: string; tags: string[] }): void {
  void (async () => {
    const base = await getEmbeddingBaseUrl()
    if (!base) return
    const vec = await embedTexts([docText(entry)])
    if (!vec) return
    await db.knowledgeEmbedding.upsert({
      where: { entryId: entry.id },
      create: { entryId: entry.id, vector: JSON.stringify(vec[0]), model: EMBED_MODEL, dims: vec[0].length },
      update: { vector: JSON.stringify(vec[0]), model: EMBED_MODEL, dims: vec[0].length, ts: new Date() },
    })
    invalidateVectorCache()
  })().catch(() => {})
}

/** Health + proof-of-work probe for the operator: is the embedder configured,
 *  reachable, how much is indexed, and does SEMANTIC search actually rank a
 *  zero-token-overlap query correctly (the thing keyword search cannot do)? */
export async function vectorTest(): Promise<{
  configured: boolean
  reachable: boolean
  indexed: number
  total: number
  dims: number | null
  semanticHit: boolean
  keywordHit: boolean
  probe: string
  topTitle: string | null
  disabledBySwitch?: boolean
}> {
  const base = await getEmbeddingBaseUrl()
  // the master switch outranks the URL: OFF means the vector DB is off entirely
  const vectorOn = (await getKnowledgeFlags()).vector
  const rows = await db.knowledgeEmbedding.findMany()
  const total = await db.knowledgeEntry.count({ where: { enabled: true } })
  const dims = rows[0]?.dims ?? null
  // reachability probe: embed a single token
  const ping = await embedTexts(['ping'])
  const reachable = !!ping
  // zero-overlap probe: shares NO word with the timeout-math entry, but means it
  const probe = 'why did my process die at a minute and a half'
  let semanticHit = false
  let topTitle: string | null = null
  let keywordHit = false
  if (reachable && rows.length) {
    const vhits = await vectorSearch(probe, 3)
    if (vhits) {
      const top = [...vhits.entries()].sort((a, b) => b[1] - a[1])
      const hit = await db.knowledgeEntry.findUnique({ where: { id: top[0]?.[0] ?? -1 } })
      topTitle = hit?.title ?? null
      for (const [id] of top) {
        const e = await db.knowledgeEntry.findUnique({ where: { id } })
        if (e && /90s timeout|sweep time math/i.test(e.title)) semanticHit = true
      }
    }
  }
  // keyword-only comparison on the same probe (expect: no hit — that's the point)
  const { tokenize } = await import('./knowledge')
  const kw = await db.knowledgeEntry.findFirst({ where: { title: { contains: 'sweep time math' } } })
  if (kw) {
    // cheap keyword check: does ANY probe token appear in the entry text?
    const hay = `${kw.title} ${kw.content}`.toLowerCase()
    keywordHit = tokenize(probe).some((t) => hay.includes(t))
  }
  return { configured: !!base && vectorOn, reachable, indexed: rows.length, total, dims, semanticHit, keywordHit, probe, topTitle, ...(vectorOn ? {} : { disabledBySwitch: true }) }
}

/** Embed every entry missing a vector (or all when force). */
export async function reindexKnowledge(force = false): Promise<{ indexed: number; total: number; skipped: boolean; reason?: string }> {
  // switch off → report that instead of trying to reach the (gated) embedder
  if (!(await getKnowledgeFlags()).vector) return { indexed: 0, total: 0, skipped: true, reason: 'vector DB is switched off (Settings → knowledge system)' }
  const base = await getEmbeddingBaseUrl()
  if (!base) return { indexed: 0, total: 0, skipped: true }
  const entries = await db.knowledgeEntry.findMany({ where: { enabled: true } })
  if (force) await db.knowledgeEmbedding.deleteMany()
  const have = new Set((await db.knowledgeEmbedding.findMany()).map((r) => r.entryId))
  const todo = entries.filter((e) => !have.has(e.id))
  if (!todo.length) return { indexed: 0, total: entries.length, skipped: false }

  let indexed = 0
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH)
    const vecs = await embedTexts(slice.map((e) => {
      let tags: string[] = []
      try { const t = JSON.parse(e.tags); if (Array.isArray(t)) tags = t } catch { /* ignore */ }
      return docText({ kind: e.kind, tool: e.tool, title: e.title, content: e.content, tags })
    }))
    if (!vecs) return { indexed, total: entries.length, skipped: false } // embedder died mid-run — keep what we got
    for (let j = 0; j < slice.length; j++) {
      await db.knowledgeEmbedding.upsert({
        where: { entryId: slice[j].id },
        create: { entryId: slice[j].id, vector: JSON.stringify(vecs[j]), model: EMBED_MODEL, dims: vecs[j].length },
        update: { vector: JSON.stringify(vecs[j]), model: EMBED_MODEL, dims: vecs[j].length, ts: new Date() },
      })
      indexed++
    }
  }
  invalidateVectorCache()
  invalidateKnowledgeCache()
  return { indexed, total: entries.length, skipped: false }
}
