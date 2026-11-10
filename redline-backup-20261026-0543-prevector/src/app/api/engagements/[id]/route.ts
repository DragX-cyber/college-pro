import { NextResponse } from 'next/server'
import { db } from '@/core/db'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const numId = Number(id)
  if (!Number.isFinite(numId)) return NextResponse.json({ ok: false, error: 'bad id' }, { status: 400 })
  const engagement = await db.engagement.findUnique({
    where: { id: numId },
    include: {
      tasks: { orderBy: [{ phase: 'asc' }, { parallelGroup: 'asc' }, { id: 'asc' }] },
      findings: { orderBy: { id: 'desc' } },
    },
  })
  if (!engagement) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
  return NextResponse.json({ engagement })
}
