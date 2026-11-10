import { NextResponse } from 'next/server'
import { audit } from '@/core/audit'
import { importDocument } from '@/core/knowledge-import'

export const runtime = 'nodejs' // pdf-parse / mammoth need real Node APIs

// Operator document → knowledge entries. Text is extracted (PDF/DOCX/text),
// then the configured LLM converts it into structured entries via one strict
// JSON prompt per chunk. Nothing from the document executes.
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: 'multipart field "file" required' }, { status: 400 })
  }
  const buffer = Buffer.from(await file.arrayBuffer())
  const r = await importDocument(file.name || 'document', buffer)
  if (r.ok) {
    await audit('knowledge_imported', {
      file: file.name,
      entries: r.entries.length,
      kinds: [...new Set(r.entries.map((e) => e.kind))],
      detail: r.detail,
    }, { actor: 'operator', verdict: 'info' })
  }
  return NextResponse.json(r, { status: r.ok ? 200 : 400 })
}
