import { NextResponse } from 'next/server'
import { arsenalCatalog, generateArsenal } from '@/core/redteam/arsenal'

// Red Team Arsenal — pure generation endpoints. Nothing executes here; any
// command a client or the agent derives from these outputs still passes the
// full guard chain when run.
export async function GET() {
  return NextResponse.json({ kinds: arsenalCatalog() })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const kind = String(body.kind ?? '').trim()
  if (!kind) return NextResponse.json({ ok: false, error: 'kind required' }, { status: 400 })
  const opts: Record<string, string> = {}
  for (const [k, v] of Object.entries(body)) {
    if (k !== 'kind' && (typeof v === 'string' || typeof v === 'number')) opts[k] = String(v)
  }
  const item = generateArsenal(kind, opts)
  if ('error' in item) return NextResponse.json({ ok: false, error: item.error }, { status: 400 })
  return NextResponse.json({ ok: true, item })
}
