// Platform settings — persisted in the Setting table, read fresh where it
// matters. The MODE persists across restarts until the operator switches back
// (per the UNRESTRICTED contract).
import { db } from './db'
import type { Mode, ProviderId, ThinkingLevel } from './types'

export interface Budgets {
  stepsPerTurn: number
  turnSeconds: number
  commandSeconds: number
}

export interface PlatformSettings {
  mode: Mode
  thinkingLevel: ThinkingLevel
  provider: ProviderId
  model: string
  baseUrl: string
  apiKey: string
  /** dedicated embedding server for vector knowledge search ('' = disabled) */
  embeddingBaseUrl: string
  budgets: Budgets
  /** GUARDED mode approval seat — default OFF = every closed-set action waits for a human */
  autoApproveClosedSet: boolean
  /** FREE mode convenience: auto-approve non-read-only commands (still fully audited) */
  autoApproveNonReadOnly: boolean
  /** UNRESTRICTED-only endurance switch: no step/turn/command time limits
   *  (1000 steps · 24h turns · 1h commands) and no per-minute rate cap */
  endurance: boolean
  killSwitch: boolean
  /** Knowledge base master switch — OFF means the agent gets ZERO knowledge:
   *  no prompt injection, no get_knowledge, no command hints, no autolearn. */
  knowledgeEnabled: boolean
  /** RAG retrieval paths (turn-start context, get_knowledge action, command
   *  hints). Effective only when knowledgeEnabled is also true. */
  ragEnabled: boolean
  /** Vector DB (embeddings + semantic search). Effective only when
   *  knowledgeEnabled is also true. OFF = keyword-only, no new vectors. */
  vectorEnabled: boolean
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  mode: 'free',
  thinkingLevel: 'medium',
  provider: 'zai',
  model: '',
  baseUrl: '',
  apiKey: '',
  embeddingBaseUrl: 'http://localhost:8081/v1',
  budgets: { stepsPerTurn: 24, turnSeconds: 240, commandSeconds: 90 },
  autoApproveClosedSet: false,
  autoApproveNonReadOnly: false,
  endurance: false,
  killSwitch: false,
  knowledgeEnabled: true,
  ragEnabled: true,
  vectorEnabled: true,
}

export async function getSettings(): Promise<PlatformSettings> {
  const rows = await db.setting.findMany()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const s = { ...DEFAULT_SETTINGS }
  const mode = map.get('mode')
  if (mode === 'guarded' || mode === 'free' || mode === 'unrestricted') s.mode = mode
  const thinkingLevel = map.get('thinkingLevel') as ThinkingLevel | undefined
  if (thinkingLevel === 'low' || thinkingLevel === 'medium' || thinkingLevel === 'high') s.thinkingLevel = thinkingLevel
  const provider = map.get('provider') as ProviderId | undefined
  if (provider) s.provider = provider
  s.model = map.get('model') ?? s.model
  s.baseUrl = map.get('baseUrl') ?? s.baseUrl
  s.apiKey = map.get('apiKey') ?? s.apiKey
  // '' explicitly disables vector search; unset falls back to the default
  s.embeddingBaseUrl = map.has('embeddingBaseUrl') ? (map.get('embeddingBaseUrl') ?? '') : s.embeddingBaseUrl
  try {
    const raw = map.get('budgets')
    if (raw) s.budgets = { ...DEFAULT_SETTINGS.budgets, ...JSON.parse(raw) }
  } catch { /* keep defaults */ }
  s.autoApproveClosedSet = map.get('autoApproveClosedSet') === 'true'
  s.autoApproveNonReadOnly = map.get('autoApproveNonReadOnly') === 'true'
  // endurance only ever reads as ON inside unrestricted — leaving the mode
  // disables it so it can never silently linger
  s.endurance = map.get('endurance') === 'true' && s.mode === 'unrestricted'
  s.killSwitch = map.get('kill_switch') === 'on'
  // knowledge system toggles — unknown/unset values keep the default (ON)
  const knowledge = map.get('knowledgeEnabled')
  if (knowledge === 'true' || knowledge === 'false') s.knowledgeEnabled = knowledge === 'true'
  const rag = map.get('ragEnabled')
  if (rag === 'true' || rag === 'false') s.ragEnabled = rag === 'true'
  const vec = map.get('vectorEnabled')
  if (vec === 'true' || vec === 'false') s.vectorEnabled = vec === 'true'
  return s
}

export async function getMode(): Promise<Mode> {
  return (await getSettings()).mode
}

export async function setSetting(key: string, value: string) {
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

export async function setSettings(patch: Partial<PlatformSettings>) {
  const ops: Promise<any>[] = []
  if (patch.mode) ops.push(setSetting('mode', patch.mode))
  if (patch.thinkingLevel) ops.push(setSetting('thinkingLevel', patch.thinkingLevel))
  if (patch.provider) ops.push(setSetting('provider', patch.provider))
  if (patch.model !== undefined) ops.push(setSetting('model', patch.model))
  if (patch.baseUrl !== undefined) ops.push(setSetting('baseUrl', patch.baseUrl))
  if (patch.embeddingBaseUrl !== undefined) ops.push(setSetting('embeddingBaseUrl', patch.embeddingBaseUrl))
  if (patch.apiKey !== undefined) ops.push(setSetting('apiKey', patch.apiKey))
  if (patch.budgets) ops.push(setSetting('budgets', JSON.stringify(patch.budgets)))
  if (patch.autoApproveClosedSet !== undefined) ops.push(setSetting('autoApproveClosedSet', String(patch.autoApproveClosedSet)))
  if (patch.autoApproveNonReadOnly !== undefined) ops.push(setSetting('autoApproveNonReadOnly', String(patch.autoApproveNonReadOnly)))
  if (patch.endurance !== undefined) ops.push(setSetting('endurance', String(patch.endurance)))
  if (patch.killSwitch !== undefined) ops.push(setSetting('kill_switch', patch.killSwitch ? 'on' : 'off'))
  if (patch.knowledgeEnabled !== undefined) ops.push(setSetting('knowledgeEnabled', String(patch.knowledgeEnabled)))
  if (patch.ragEnabled !== undefined) ops.push(setSetting('ragEnabled', String(patch.ragEnabled)))
  if (patch.vectorEnabled !== undefined) ops.push(setSetting('vectorEnabled', String(patch.vectorEnabled)))
  await Promise.all(ops)
}

export async function setKillSwitch(enabled: boolean) {
  await setSetting('kill_switch', enabled ? 'on' : 'off')
}

// ─── knowledge system switches ────────────────────────────────────────────────

export interface KnowledgeSystemFlags {
  /** knowledge base master — OFF disables everything below unconditionally */
  knowledge: boolean
  /** RAG retrieval: turn-start context, get_knowledge action, command hints */
  rag: boolean
  /** vector DB: embeddings + semantic search (OFF → keyword-only retrieval) */
  vector: boolean
}

/** Effective knowledge-system flags with hierarchy applied: RAG and the
 *  vector DB only reach the agent when the knowledge master is ON too. */
export async function getKnowledgeFlags(): Promise<KnowledgeSystemFlags> {
  const s = await getSettings()
  const knowledge = s.knowledgeEnabled
  return { knowledge, rag: knowledge && s.ragEnabled, vector: knowledge && s.vectorEnabled }
}
