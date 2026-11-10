import { NextResponse } from 'next/server'
import { db } from '@/core/db'

export async function GET() {
  const engagements = await db.engagement.findMany({
    orderBy: { id: 'desc' },
    take: 50,
    include: {
      _count: { select: { tasks: true, findings: true } },
    },
  })
  return NextResponse.json({ engagements })
}
