import { NextResponse } from 'next/server'
import { audit } from '@/core/audit'
import { updateKnowledge, deleteKnowledge, KNOWLEDGE_KINDS, type KnowledgeKind } from '@/core/knowledge'

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const numId = Number(id)
  if (!Number.isFinite(numId)) return NextResponse.json({ ok: false, error: 'bad id' }, { status: 400 })
  const body = await req.json().catch(() => ({}))
  const patch: Parameters<typeof updateKnowledge>[1] = {}
  if (body.kind !== undefined) {
    if (!KNOWLEDGE_KINDS.includes(String(body.kind) as KnowledgeKind)) {
      return NextResponse.json({ ok: false, error: `kind must be one of ${KNOWLEDGE_KINDS.join('|')}` }, { status: 400 })
    }
    patch.kind = String(body.kind) as KnowledgeKind
  }
  if (body.title !== undefined) patch.title = String(body.title)
  if (body.content !== undefined) patch.content = String(body.content)
  if (body.tool !== undefined) patch.tool = body.tool ? String(body.tool) : null
  if (body.tags !== undefined) patch.tags = Array.isArray(body.tags) ? body.tags.map(String) : []
  if (body.enabled !== undefined) patch.enabled = !!body.enabled

  const entry = await updateKnowledge(numId, patch)
  if (!entry) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
  await audit('knowledge_updated', { id: entry.id, fields: Object.keys(patch) }, { actor: 'operator', verdict: 'info' })
  return NextResponse.json({ ok: true, entry })
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const numId = Number(id)
  if (!Number.isFinite(numId)) return NextResponse.json({ ok: false, error: 'bad id' }, { status: 400 })
  const ok = await deleteKnowledge(numId)
  if (!ok) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
  await audit('knowledge_deleted', { id: numId }, { actor: 'operator', verdict: 'info' })
  return NextResponse.json({ ok: true })
}
