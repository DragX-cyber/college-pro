import { NextResponse } from 'next/server'
import { resolveApproval } from '@/core/guards'

// Backup decision path (the primary is the socket service, which resumes the
// waiting agent loop instantly). Works for cards raised by any runner.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const decision = body.decision === 'approved' ? 'approved' : body.decision === 'denied' ? 'denied' : null
  if (!decision) return NextResponse.json({ ok: false, error: 'decision must be approved|denied' }, { status: 400 })
  const ok = await resolveApproval(id, decision, 'operator(rest)')
  if (!ok) return NextResponse.json({ ok: false, error: 'not pending or not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
