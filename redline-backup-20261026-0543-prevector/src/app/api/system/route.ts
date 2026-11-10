import { NextResponse } from 'next/server'
import { getSettings } from '@/core/settings'
import { charterSummary } from '@/core/charter'
import { detectOS } from '@/core/os'
import { getRegistry } from '@/core/tools/registry'
import { PROVIDERS } from '@/core/agent/llm'
import { db } from '@/core/db'

export async function GET() {
  const settings = await getSettings()
  const charter = charterSummary()
  const tools = getRegistry({ resolveAvailability: true })
  const [actions, refusals, findings, honeypots, pending] = await Promise.all([
    db.toolRun.count(),
    db.auditEvent.count({ where: { verdict: { in: ['refused', 'blocked'] } } }),
    db.finding.count(),
    db.finding.count({ where: { kind: 'honeypot' } }),
    db.approvalRequest.count({ where: { status: 'pending' } }),
  ])
  return NextResponse.json({
    mode: settings.mode,
    thinkingLevel: settings.thinkingLevel,
    killSwitch: settings.killSwitch,
    endurance: settings.endurance,
    budgets: settings.budgets,
    provider: settings.provider,
    model: settings.model,
    os: detectOS(),
    charter,
    tools: tools.map((t) => ({
      id: t.id, name: t.name, category: t.category, tagline: t.tagline,
      availability: t.availability, builtin: !!t.builtin,
    })),
    providers: PROVIDERS,
    stats: { actions, refusals, findings, honeypots, pendingApprovals: pending },
  })
}
