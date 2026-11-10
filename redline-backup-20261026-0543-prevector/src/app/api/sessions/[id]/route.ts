import { NextResponse } from 'next/server'
import { db } from '@/core/db'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const session = await db.chatSession.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { id: 'asc' }, take: 200 },
    },
  })
  if (!session) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
  return NextResponse.json({ session })
}
