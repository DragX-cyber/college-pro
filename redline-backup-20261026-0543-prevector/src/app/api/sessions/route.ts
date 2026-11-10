import { NextResponse } from 'next/server'
import { db } from '@/core/db'

export async function GET() {
  const sessions = await db.chatSession.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { _count: { select: { messages: true } } },
  })
  return NextResponse.json({ sessions })
}
