import { NextResponse } from 'next/server'
import { listAudit } from '@/core/audit'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const limit = Number(url.searchParams.get('limit') ?? 100)
  const kind = url.searchParams.get('kind') ?? undefined
  const mode = url.searchParams.get('mode') ?? undefined
  const rows = await listAudit({ limit, kind, mode })
  return NextResponse.json({ events: rows })
}
