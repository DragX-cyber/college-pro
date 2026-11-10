import { NextResponse } from 'next/server'
import { audit } from '@/core/audit'
import {
  listKnowledge, createKnowledge, searchKnowledge, seedKnowledge,
  KNOWLEDGE_KINDS, type KnowledgeKind,
} from '@/core/knowledge'
import { ingestOnlineDocs } from '@/core/knowledge-online'
import { reindexKnowledge } from '@/core/knowledge-embed'
import { db } from '@/core/db'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const q = url.searchParams.get('q')
  if (q) {
    // operator-facing search: bypasses the agent-side switches so the page can
    // search the full base even while retrieval to the model is off
    const hits = await searchKnowledge(q, { limit: 20, ignoreSettings: true })
    return NextResponse.json({ entries: hits.map((h) => ({ ...h.entry, score: h.score })) })
  }
  const entries = await listKnowledge()
  const [indexed, total] = await Promise.all([
    db.knowledgeEmbedding.count(),
    db.knowledgeEntry.count({ where: { enabled: true } }),
  ])
  return NextResponse.json({ entries, embedded: { indexed, total } })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  // action:seed re-runs the curated pack (replaces seed entries)
  if (body.action === 'seed') {
    const r = await seedKnowledge(true)
    await audit('knowledge_seeded', { inserted: r.inserted }, { actor: 'operator', verdict: 'info' })
    return NextResponse.json({ ok: true, ...r })
  }
  // action:reindex embeds knowledge entries missing vectors (dedicated embedder :8081)
  if (body.action === 'reindex') {
    const r = await reindexKnowledge(!!body.force)
    return NextResponse.json({ ok: true, ...r })
  }
  // action:ingest_docs pulls tldr command docs for installed tools from tldr-pages
  if (body.action === 'ingest_docs') {
    const r = await ingestOnlineDocs(Array.isArray(body.tools) ? body.tools.map(String) : undefined)
    return NextResponse.json({ ok: true, ...r })
  }
  const kind = String(body.kind ?? '') as KnowledgeKind
  const title = String(body.title ?? '').trim()
  const content = String(body.content ?? '').trim()
  if (!KNOWLEDGE_KINDS.includes(kind) || !title || !content) {
    return NextResponse.json({ ok: false, error: 'kind must be one of tool_usage|command_syntax|mistake|planning, title and content required' }, { status: 400 })
  }
  const entry = await createKnowledge({
    kind,
    title,
    content,
    tool: body.tool ? String(body.tool) : null,
    tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
    source: 'operator',
  })
  await audit('knowledge_added', { id: entry.id, kind, tool: entry.tool, title }, { actor: 'operator', verdict: 'info' })
  return NextResponse.json({ ok: true, entry })
}
