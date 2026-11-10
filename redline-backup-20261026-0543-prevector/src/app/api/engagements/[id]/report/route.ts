import { NextResponse } from 'next/server'
import { generateReport } from '@/core/redteam/engines'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const numId = Number(id)
  if (!Number.isFinite(numId)) return NextResponse.json({ ok: false, error: 'bad id' }, { status: 400 })
  const report = await generateReport(numId)
  return NextResponse.json({ ok: true, report })
}
