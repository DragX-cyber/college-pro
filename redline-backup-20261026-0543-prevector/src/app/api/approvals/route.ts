import { NextResponse } from 'next/server'
import { listPendingApprovals } from '@/core/guards'
import { db } from '@/core/db'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const all = url.searchParams.get('all') === '1'
  const rows = all
    ? await db.approvalRequest.findMany({ orderBy: { id: 'desc' }, take: 100 })
    : await listPendingApprovals()
  return NextResponse.json({ approvals: rows })
}
