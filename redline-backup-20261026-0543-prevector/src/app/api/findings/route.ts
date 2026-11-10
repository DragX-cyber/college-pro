import { NextResponse } from 'next/server'
import { db } from '@/core/db'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200)
  const findings = await db.finding.findMany({ orderBy: { id: 'desc' }, take: limit })
  return NextResponse.json({ findings })
}
