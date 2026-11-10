import { NextResponse } from 'next/server'
import { charterSummary, addHost, removeHost, saveCharter, loadCharter } from '@/core/charter'
import { audit } from '@/core/audit'

// NOTE: charter routes are OPERATOR-ONLY surfaces. The AI agent has no code
// path that reaches them — when the agent tried to widen its own scope by
// editing the charter from its terminal, the guard refused the command.

export async function GET() {
  return NextResponse.json({ charter: charterSummary() })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '')

  if (action === 'add') {
    const r = await addHost(String(body.host ?? ''), { detect: !!body.detect })
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 400 })
    return NextResponse.json({
      ok: true,
      added: r.added,
      ips: (r as any).ips ?? [],
      findings: (r as any).findings ?? [],
      charter: charterSummary(),
    })
  }

  if (action === 'remove') {
    const r = await removeHost(String(body.host ?? ''))
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 400 })
    return NextResponse.json({ ok: true, charter: charterSummary() })
  }

  if (action === 'roe') {
    const charter = loadCharter()
    const roe = charter.rules_of_engagement
    if (body.max_concurrent_actions !== undefined) roe.max_concurrent_actions = Math.max(1, Math.min(16, Number(body.max_concurrent_actions) || 1))
    if (body.rate_limit_per_minute !== undefined) roe.rate_limit_per_minute = Math.max(1, Math.min(600, Number(body.rate_limit_per_minute) || 30))
    if (body.time_budget_minutes !== undefined) roe.time_budget_minutes = Math.max(5, Math.min(1440, Number(body.time_budget_minutes) || 90))
    if (body.max_rung !== undefined) charter.exploitation.max_rung = Math.max(1, Math.min(5, Number(body.max_rung) || 3))
    if (body.honeypot_threshold !== undefined) charter.deception.honeypot_threshold = Math.max(10, Math.min(100, Number(body.honeypot_threshold) || 60))
    // destructive_actions and replica_host stay operator-file edits only
    saveCharter(charter)
    await audit('charter_changed', { action: 'roe_update', roe: charter.rules_of_engagement }, { actor: 'operator', verdict: 'allowed' })
    return NextResponse.json({ ok: true, charter: charterSummary() })
  }

  return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 })
}
