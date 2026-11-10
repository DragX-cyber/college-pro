import { NextResponse } from 'next/server'
import { getSettings, setSettings } from '@/core/settings'
import { audit } from '@/core/audit'
import { PROVIDERS } from '@/core/agent/llm'
import type { ProviderId } from '@/core/types'

export async function GET() {
  const s = await getSettings()
  return NextResponse.json({
    settings: {
      ...s,
      apiKey: s.apiKey ? '••••••••' : '', // never echo the key back
      hasApiKey: !!s.apiKey,
    },
    providers: PROVIDERS,
  })
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}))
  const patch: any = {}
  const current = await getSettings()

  if (body.provider && PROVIDERS.some((p) => p.id === body.provider)) patch.provider = body.provider as ProviderId
  if (body.thinkingLevel && ['low', 'medium', 'high'].includes(body.thinkingLevel)) patch.thinkingLevel = body.thinkingLevel
  if (typeof body.model === 'string') patch.model = body.model.trim().slice(0, 120)
  if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl.trim().slice(0, 300)
  if (typeof body.embeddingBaseUrl === 'string') patch.embeddingBaseUrl = body.embeddingBaseUrl.trim().slice(0, 300)
  if (typeof body.apiKey === 'string' && body.apiKey && !body.apiKey.startsWith('••')) patch.apiKey = body.apiKey.trim().slice(0, 300)
  if (body.budgets && typeof body.budgets === 'object') {
    patch.budgets = {
      stepsPerTurn: Math.max(3, Math.min(60, Number(body.budgets.stepsPerTurn) || current.budgets.stepsPerTurn)),
      turnSeconds: Math.max(30, Math.min(1800, Number(body.budgets.turnSeconds) || current.budgets.turnSeconds)),
      commandSeconds: Math.max(5, Math.min(600, Number(body.budgets.commandSeconds) || current.budgets.commandSeconds)),
    }
  }
  if (typeof body.autoApproveClosedSet === 'boolean') patch.autoApproveClosedSet = body.autoApproveClosedSet
  if (typeof body.autoApproveNonReadOnly === 'boolean') patch.autoApproveNonReadOnly = body.autoApproveNonReadOnly
  // knowledge system switches — stored independently, hierarchy applied at read
  if (typeof body.knowledgeEnabled === 'boolean') patch.knowledgeEnabled = body.knowledgeEnabled
  if (typeof body.ragEnabled === 'boolean') patch.ragEnabled = body.ragEnabled
  if (typeof body.vectorEnabled === 'boolean') patch.vectorEnabled = body.vectorEnabled
  // ENDURANCE is unrestricted-only — refuse it anywhere else
  if (typeof body.endurance === 'boolean') {
    if (current.mode !== 'unrestricted') return NextResponse.json({ ok: false, error: 'endurance is only available in unrestricted mode' }, { status: 400 })
    patch.endurance = body.endurance
  }

  await setSettings(patch)
  await audit('settings_changed', { keys: Object.keys(patch) }, { actor: 'operator', verdict: 'info' })
  const s = await getSettings()
  return NextResponse.json({ ok: true, settings: { ...s, apiKey: s.apiKey ? '••••••••' : '', hasApiKey: !!s.apiKey } })
}
