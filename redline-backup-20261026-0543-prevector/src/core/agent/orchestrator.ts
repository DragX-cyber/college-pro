// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator — the agentic loop (ReAct over a normalized JSON protocol).
// The model reasons → acts → reads observations → adapts. Every executable
// action passes through the guard pipeline (wrapper.ts); nothing here can
// spawn a process directly. Works identically for the web console (socket),
// the CLI, and the engagement runner.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '../db'
import { audit } from '../audit'
import { loadCharter } from '../charter'
import { getSettings, getKnowledgeFlags } from '../settings'
import { detectOS } from '../os'
import { getRegistry, warmRegistry } from '../tools/registry'
import { selectStrategy } from '../tools/selector'
import { runTool, runGuardedCheck, type GuardedCheck } from '../wrapper'
import { planBatch, formatBatchObservation, type BatchResult } from '../tools/batch'
import { arsenalCatalog, generateArsenal } from '../redteam/arsenal'
import { checkRateLimit } from '../guards'
import { buildSystemPrompt } from './prompts'
import { getKnowledgeContext, createCommandHint, recordMistake, searchKnowledge } from '../knowledge'
import { chatComplete, type ChatMessage } from './llm'
import { clearStop, isStopRequested, isKillSwitchEngaged } from './abort'
import { RedLineStreamParser } from './stream-parser'
import { analyzeText } from '../redteam/honeypot'
import type { AgentEvent, EmitFn, FindingInput, GuardRefusal, Mode } from '../types'

export interface TurnInput {
  sessionId: string
  userText: string
  mode?: Mode
  emit: EmitFn
  engagement?: { id: number; target: string } | null
  /** true when the turn continues an existing conversation (no new user save) */
  isContinuation?: boolean
}

const ALLOWED_GUARDED = new Set(['run_check', 'flag_honeypot', 'note_finding', 'final', 'get_tool_strategy', 'get_knowledge'])
const VALID_ACTIONS = new Set([...ALLOWED_GUARDED, 'shell', 'shell_batch', 'generate_payload'])
const ENGAGE_WORDS = ['engagement', 'start_engagement', 'plan_engagement', 'engage']

/** Normalize a parsed JSON object into an action — accepts the spec shape
 *  {"thought":..,"action":{"tool":..}} AND the flat {"tool":..} shape some
 *  models emit. Returns null when no executable action is present. */
function resolveAction(parsed: any): ParsedAction | null {
  if (!parsed || typeof parsed !== 'object') return null
  const nested = parsed.action
  if (nested && typeof nested === 'object' && typeof nested.tool === 'string') {
    return { thought: parsed.thought ?? parsed.reasoning ?? nested.reason, ...nested }
  }
  if (typeof parsed.tool === 'string') return parsed as ParsedAction
  if (typeof parsed.final === 'string' || typeof parsed.text === 'string') {
    return { tool: 'final', text: parsed.final ?? parsed.text }
  }
  return null
}

/**
 * Scan final-answer text for an embedded next action. Handles every shape
 * small models produce: a single flat/nested object, AND the two-line spec
 * pair `{"thought":...}` + `{"action":{...}}`. Returns thoughtOnly when the
 * text carried reasoning but no executable action.
 */
export function extractEmbeddedAction(text: string): { action: ParsedAction | null; thoughtOnly: boolean } {
  let thoughtOnly = false
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    const parsed = extractJson(text.slice(i))
    if (!parsed || typeof parsed !== 'object') continue
    const candidate = resolveAction(parsed)
    if (candidate && typeof candidate.tool === 'string' && VALID_ACTIONS.has(candidate.tool) && candidate.tool !== 'final') {
      return { action: candidate, thoughtOnly: false }
    }
    if ((parsed as any).thought || (parsed as any).action) thoughtOnly = true
  }
  return { action: null, thoughtOnly }
}

/** Compact echo of the model's action back into the conversation (token diet). */
const echo = (action: ParsedAction): string => JSON.stringify(action).slice(0, 150)

/** Mid-turn compaction: when the conversation grows past maxChars, older
 *  OBSERVATION bodies collapse to one-liners (last `keepLast` stay full).
 *  Full command outputs always remain in the ToolRun audit trail. */
function compactMessages(messages: ChatMessage[], maxChars = 18_000, keepLast = 4): void {
  const size = () => messages.reduce((s, m) => s + m.content.length, 0)
  if (size() <= maxChars) return
  const obsIdx: number[] = []
  messages.forEach((m, i) => { if (m.role === 'user' && m.content.startsWith('OBSERVATION')) obsIdx.push(i) })
  const protect = new Set(obsIdx.slice(-keepLast))
  for (const i of obsIdx) {
    if (protect.has(i)) continue
    const first = messages[i].content.split('\n')[0].slice(0, 140)
    messages[i] = { ...messages[i], content: `${first}\n…(compacted — full output is in the audit trail)` }
    if (size() <= maxChars) break
  }
}

/** Resolve an optional model-requested command timeout: clamp to [5s, 600s]
 *  and to the remaining turn budget (a command can't meaningfully outlive
 *  its turn). undefined → wrapper default (settings.budgets.commandSeconds). */
function resolveTimeoutMs(requested: unknown, msLeft: number, maxMs = 600_000): number | undefined {
  const n = Number(requested)
  if (!Number.isFinite(n) || n <= 0) return undefined
  const clamped = Math.min(Math.max(n, 5_000), maxMs)
  return Math.max(5_000, Math.min(clamped, msLeft))
}

/** Small models often emit the binary itself as the action tool name —
 *  {"tool":"nmap","command":"nmap -sV x"} or {"tool":"ping","target":"h"} —
 *  instead of the documented {"tool":"shell","command":"..."}. Rebuild the
 *  command they obviously meant; it still passes the full guard chain. */
function rebuildShellCommand(tool: string, action: ParsedAction): string | null {
  const cmd = String(action.command ?? '').trim()
  if (cmd) return cmd
  const args = Array.isArray(action.args) ? action.args.map((a) => String(a)).join(' ').trim() : ''
  if (args) return `${tool} ${args}`
  const target = String(action.target ?? action.host ?? '').trim()
  // sanity: non-empty, no shell metacharacters smuggled into a synthesized command
  if (target && /^[^;&|`$<>\n\r]{1,300}$/.test(target)) return `${tool} ${target}`
  return null
}

interface ParsedAction {
  thought?: string
  tool: string
  [k: string]: unknown
}

function extractJson(text: string): any | null {
  // ```json ... ``` block first
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = fence ? [fence[1]] : [text]
  for (const c of candidates) {
    const start = c.indexOf('{')
    if (start === -1) continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < c.length; i++) {
      const ch = c[i]
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"' && !esc) inStr = !inStr
      if (inStr) continue
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(c.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}

function tail(text: string, max = 1400): string {
  const t = text.replace(/\x1b\[[0-9;]*m/g, '').trim()
  if (t.length <= max) return t
  return t.slice(0, 700) + '\n[... middle truncated ...]\n' + t.slice(-Math.max(0, max - 750))
}

async function saveFinding(f: FindingInput, emit: EmitFn) {
  const row = await db.finding.create({
    data: {
      kind: f.kind,
      title: f.title,
      detail: f.detail,
      severity: f.severity ?? 'info',
      engagementId: f.engagementId ?? null,
      sessionId: f.sessionId ?? null,
      honeypotScore: f.honeypotScore ?? null,
      evidence: f.evidence ?? null,
    },
  })
  await emit({ type: 'finding', finding: { ...f } })
  return row
}

export async function runTurn(input: TurnInput): Promise<void> {
  const settings = await getSettings()
  const mode = input.mode ?? settings.mode
  const turnId = `turn-${Date.now().toString(36)}`
  const started = Date.now()
  // a stale stop flag (pressed after the previous turn already ended) must
  // never kill a brand-new turn — each turn starts armed-free
  clearStop(input.sessionId)
  // ENDURANCE (unrestricted only): every time/budget guard lifted. The
  // ceilings that remain (1000 steps · 24h · 1h/command) exist only so a
  // broken loop can't spin forever — nothing practical limits a turn.
  const endurance = mode === 'unrestricted' && settings.endurance
  const budgets = endurance
    ? { stepsPerTurn: 1000, turnSeconds: 86_400, commandSeconds: 3_600 }
    : settings.budgets
  const maxSteps = budgets.stepsPerTurn
  const deadline = started + budgets.turnSeconds * 1000

  await input.emit({ type: 'agent_start', turnId, mode, maxSteps })

  // Ensure the session row exists (CLI one-shot sessions are created lazily).
  await db.chatSession.upsert({
    where: { id: input.sessionId },
    create: { id: input.sessionId, title: input.userText.slice(0, 60) || 'session', mode },
    update: {},
  })

  if (settings.killSwitch || isKillSwitchEngaged()) {
    const killRefusal: GuardRefusal = {
      ok: false,
      kind: 'kill_switch',
      reason: 'KILL SWITCH is ON — every action is refused until the operator clears it',
      fix: 'Clear the kill switch in the sidebar or via /kill in the CLI',
      auditKind: 'kill_switch',
      verdict: 'blocked',
    }
    await input.emit({ type: 'guard', refusal: killRefusal })
    await input.emit({ type: 'final', text: '🛑 **KILL SWITCH IS ENGAGED**: Operations are suspended. Clear the kill switch in the sidebar to resume.' })
    await input.emit({ type: 'agent_end', turnId: `turn-${Date.now()}`, steps: 0 })
    return
  }

  // Warm the registry so the prompt reflects installed marketplace tools.
  await warmRegistry()
  const charter = loadCharter()
  const osInfo = detectOS()
  const tools = getRegistry({ resolveAvailability: true })

  const engagementInfo = input.engagement
    ? await db.engagement.findUnique({ where: { id: input.engagement.id } })
    : null
  // Knowledge RAG: entries relevant to this task ride the system prompt.
  const knowledge = await getKnowledgeContext(input.userText).catch(() => '')
  const systemPrompt = buildSystemPrompt({
    mode,
    thinkingLevel: settings.thinkingLevel,
    osInfo,
    charter,
    tools,
    budgets,
    knowledge: knowledge || undefined,
    engagement: engagementInfo
      ? { eid: engagementInfo.eid, target: engagementInfo.target, objective: engagementInfo.objective, profile: engagementInfo.profile }
      : null,
  })

  // ── history: persisted user/assistant turns, compacted ──
  const historyRows = await db.chatMessage.findMany({
    where: { sessionId: input.sessionId, role: { in: ['user', 'assistant'] } },
    orderBy: { id: 'desc' },
    take: 8,
  })
  const history: ChatMessage[] = historyRows
    .reverse()
    .flatMap((r, i, arr): ChatMessage[] => {
      const isLatestAssistant = r.role === 'assistant' && i === arr.length - 1
      const maxLen = r.role === 'user' ? 800 : isLatestAssistant ? 700 : 350
      return r.content
        ? [{ role: r.role as 'user' | 'assistant', content: tail(r.content, maxLen) }]
        : []
    })

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...history]
  messages.push({ role: 'user', content: `[CURRENT TASK: "${input.userText}"]\n${input.userText}` })

  if (!input.isContinuation) {
    await db.chatMessage.create({
      data: { sessionId: input.sessionId, role: 'user', content: input.userText },
    })
  }

  const actions: { tool: string; command?: string; exit?: number | null }[] = []
  const refusals: string[] = []
  const findingTitles: string[] = []
  let stepsUsed = 0
  let parseFailures = 0
  let finalText = ''
  let lastTarget: string | undefined

  const obs = (text: string) => `${text}\n[Current Task: "${input.userText.replace(/"/g, "'").slice(0, 100)}"]`

  const refuse = async (r: GuardRefusal, emit = true) => {
    refusals.push(`${r.kind}: ${r.reason}`)
    if (emit) await input.emit({ type: 'guard', refusal: r })
    await audit(r.auditKind, { sessionId: input.sessionId, reason: r.reason, command: r.kind === 'destructive_block' || r.kind === 'free_command_refused' ? String((input as any).__lastCommand ?? '') : undefined }, { mode, actor: 'agent', verdict: r.verdict })
  }

  // Operator interrupt (console Stop button → chat:stop → requestStop, or KILL SWITCH).
  // Consumes the flag, ends the turn cleanly, and lets the normal turn-teardown
  // (final, history, agent_end) run so the UI unlocks and state is preserved.
  const interruptNow = async (): Promise<boolean> => {
    const isKilled = (await getSettings()).killSwitch || isKillSwitchEngaged()
    if (isKilled) {
      clearStop(input.sessionId)
      finalText = `🛑 **EMERGENCY KILL SWITCH ENGAGED**: Operation aborted immediately by operator after ${actions.length} action(s). All child processes were terminated. Clear the kill switch in the sidebar to resume operations.`
      await input.emit({ type: 'agent_thought', text: '🛑 EMERGENCY KILL SWITCH ACTIVATED — terminating turn immediately' })
      return true
    }
    if (!isStopRequested(input.sessionId)) return false
    clearStop(input.sessionId)
    finalText = finalText || `⏹ Interrupted by operator after ${actions.length} action(s) / ${stepsUsed} step(s). Progress so far:\n${summarize(actions, refusals, findingTitles)}\nRefine and resend your prompt — the session keeps its history.`
    await input.emit({ type: 'agent_thought', text: '⏹ stop requested by operator — ending the turn' })
    return true
  }

  loop: for (let step = 0; step < maxSteps; step++) {
    stepsUsed = step + 1
    if (await interruptNow()) break loop
    const msLeft = deadline - Date.now()
    if (msLeft < 12_000) {
      await input.emit({ type: 'budget', stepsLeft: maxSteps - step, turnMsLeft: Math.max(0, msLeft) })
      finalText = finalText || `⏱ Turn budget reached (${settings.budgets.turnSeconds}s). Here is where we are:\n${summarize(actions, refusals, findingTitles)}\nSay "continue" to resume from this point.`
      break
    }
    await input.emit({ type: 'budget', stepsLeft: maxSteps - step, turnMsLeft: msLeft, promptTokens: Math.round(messages.reduce((sum, m) => sum + m.content.length, 0) / 4) } as any)

    compactMessages(messages)
    const parser = new RedLineStreamParser(
      (chunk) => {
        input.emit({ type: 'thought_chunk', chunk })
      },
      (chunk) => {
        input.emit({ type: 'final_chunk', chunk })
      }
    )
    const result = await chatComplete(messages, {
      sessionId: input.sessionId,
      onChunk: (chunk) => {
        if (isStopRequested(input.sessionId)) return
        parser.feed(chunk)
      },
    })
    if (result.error || !result.content) {
      await audit('provider_error', { provider: result.provider, error: result.error }, { mode, actor: 'system' })
      await input.emit({ type: 'error', message: `LLM provider "${result.provider}" failed: ${result.error}`, fix: 'Check Settings → provider / model / baseUrl / API key (local models must be running: ollama serve, LM Studio server on).' })
      finalText = finalText || `I could not reach the model backend (${result.error}). Fix the provider settings and ask me again — nothing was executed.`
      break
    }
    // stop pressed while the model was thinking/thawing — act on nothing further
    if (await interruptNow()) break

    const raw = result.content
    const parsed = extractJson(raw)
    let action: ParsedAction | null = resolveAction(parsed)
    if (!action) {
      parseFailures++
      if (parseFailures >= 2 || step === maxSteps - 1) {
        // The model is talking instead of acting — treat its prose as the final answer.
        finalText = raw.trim() || finalText
        break
      }
      messages.push({ role: 'assistant', content: raw.slice(0, 500) })
      messages.push({ role: 'user', content: 'OBSERVATION: your reply was not a single JSON action object. Respond with EXACTLY ONE JSON object: {"thought":"...","action":{"tool":"..."}} — no prose outside the JSON.' })
      continue
    }
    parseFailures = 0

    if (action.thought) await input.emit({ type: 'agent_thought', text: String(action.thought).slice(0, 1500) })
    const tool = action.tool

    // GUARDED mode: the closed action set is the law.
    if (mode === 'guarded' && !ALLOWED_GUARDED.has(tool)) {
      const r: GuardRefusal = {
        ok: false, kind: 'mode_violation',
        reason: `GUARDED mode permits only ${Array.from(ALLOWED_GUARDED).join(', ')} — "${tool}" is refused. The model never writes commands in this mode.`,
        fix: 'Use run_check with one of: ping, nslookup, whatweb, curl',
        auditKind: 'mode_violation', verdict: 'refused',
      }
      await refuse(r)
      messages.push({ role: 'assistant', content: echo(action) })
      messages.push({ role: 'user', content: `OBSERVATION: GUARD REFUSED — ${r.reason} ${r.fix ?? ''}` })
      continue
    }

    // Engagement gate: planning is operator-only by design.
    if (ENGAGE_WORDS.includes(tool)) {
      const r: GuardRefusal = {
        ok: false, kind: 'engagement_gate',
        reason: 'Engagement planning is operator-gated — a failed quick task cannot escalate itself into an engagement.',
        fix: 'Tell the operator to open the Engagements page (web) or run /engagement (CLI) to start one.',
        auditKind: 'engagement_gate', verdict: 'refused',
      }
      await refuse(r)
      messages.push({ role: 'assistant', content: echo(action) })
      messages.push({ role: 'user', content: `OBSERVATION: GUARD REFUSED — ${r.reason}` })
      continue
    }

    // Final-wrap repair: small models sometimes emit their NEXT action inside
    // a final answer — single object, nested action, or the two-line spec pair
    // {"thought":...} \n {"action":{...}}. extractEmbeddedAction handles all
    // shapes; unwrap and execute instead of ending the turn with raw JSON.
    if (tool === 'final') {
      const rawText = String(action.text ?? action.final ?? '').trim()
      if (rawText.includes('{')) {
        const { action: embedded, thoughtOnly } = extractEmbeddedAction(rawText)
        if (embedded) {
          await input.emit({ type: 'agent_thought', text: 'repair: action was wrapped inside final — executing it' })
          action = { ...embedded, thought: String(embedded.thought ?? action.thought ?? '') }
        } else if (thoughtOnly) {
          // final contained ONLY reasoning — the model stalled mid-thought.
          // Nudge it for the action instead of ending the turn with raw JSON.
          await input.emit({ type: 'agent_thought', text: 'repair: final contained reasoning only — asking for the action' })
          messages.push({ role: 'assistant', content: echo(action) })
          messages.push({ role: 'user', content: 'OBSERVATION: that final contained only a thought, no action. Continue with EXACTLY ONE JSON object {"thought":"...","action":{"tool":"shell","command":"..."}} — or call final with the complete answer text.' })
          continue
        }
      }
    }

    // Tool-name repair (shell modes only): if the model named an actual
    // program instead of a valid action, honor the intent as a shell command.
    // GUARDED keeps its closed set — no repair there.
    if (mode !== 'guarded' && !VALID_ACTIONS.has(tool) && /^[a-z0-9][a-z0-9_.+-]*$/i.test(tool)) {
      const rebuilt = rebuildShellCommand(tool, action)
      if (rebuilt) {
        await input.emit({ type: 'agent_thought', text: `tool-name repair: "${tool}" → shell(${rebuilt})` })
        messages.push({ role: 'assistant', content: echo(action) })
        messages.push({ role: 'user', content: `NOTE: "${tool}" is not an action name — your intent was executed as {"tool":"shell","command":"${rebuilt}"}. Next time emit {"tool":"shell","command":"<the full command>"} directly.` })
        action = { ...action, tool: 'shell', command: rebuilt }
      }
    }

    switch (action.tool) {
      case 'final': {
        finalText = String(action.text ?? action.final ?? '').trim() || '(empty final)'
        break loop
      }
      case 'get_tool_strategy': {
        const task = String(action.task ?? 'port_scan')
        const priority = (['speed', 'coverage', 'stealth', 'reliability', 'balanced'].includes(String(action.priority)) ? action.priority : 'balanced') as any
        const strategy = selectStrategy(task, { priority })
        await input.emit({ type: 'tool_strategy', strategy })
        messages.push({ role: 'assistant', content: echo(action) })
        messages.push({ role: 'user', content: `OBSERVATION: tool strategy for ${task} (${priority}):\n${JSON.stringify({ primary: strategy.primary, ranked: strategy.ranked.slice(0, 4).map((c) => ({ name: c.name, score: c.score })), complement: strategy.complement, guidance: strategy.guidance }, null, 1).slice(0, 2200)}` })
        break
      }
      case 'get_knowledge': {
        // agentic RAG: the model pulls knowledge entries on demand instead of
        // carrying the whole base in the prompt (pure DB read, every mode).
        // A switched-off system reports that state plainly instead of making
        // the model search an empty haystack and conclude the base is empty.
        const kFlags = await getKnowledgeFlags()
        if (!kFlags.knowledge || !kFlags.rag) {
          const why = kFlags.knowledge ? 'RAG retrieval is switched off' : 'the knowledge base is switched off'
          await input.emit({ type: 'agent_thought', text: `knowledge lookup skipped: ${why} (Settings → knowledge system)` })
          messages.push({ role: 'assistant', content: echo(action) })
          messages.push({ role: 'user', content: `OBSERVATION: knowledge lookup unavailable — ${why} by the operator (Settings → knowledge system). Proceed from what you already know and the tool board; the registry output for each command is your source of truth.` })
          break
        }
        const query = String(action.query ?? action.task ?? input.userText).slice(0, 200)
        const kTool = action.tool ? String(action.tool).trim().toLowerCase() : undefined
        const hits = await searchKnowledge(query, { tool: kTool ?? null, limit: 4 }).catch(() => [])
        const body = hits.length
          ? hits.map(({ entry }) => `[${entry.kind}${entry.tool ? `:${entry.tool}` : ''}] ${entry.title}: ${entry.content}`).join('\n')
          : 'no matching entries — retry with the tool name, a task id (port_scan, service_enum…) or words from the error text'
        await input.emit({ type: 'agent_thought', text: `knowledge lookup: "${query}"${kTool ? ` (${kTool})` : ''} → ${hits.length} entries` })
        messages.push({ role: 'assistant', content: echo(action) })
        messages.push({ role: 'user', content: `OBSERVATION (get_knowledge "${query}"):\n${body.slice(0, 1800)}` })
        break
      }
      case 'generate_payload': {
        // Red Team Arsenal — pure text generation (no execution, no guards
        // needed). Whatever the model does with the output still goes through
        // shell + the full five-step wrapper.
        const kind = String(action.kind ?? action.payload ?? '').trim()
        const opts: Record<string, string> = {}
        for (const [k, val] of Object.entries(action)) {
          if (!['tool', 'thought', 'kind', 'payload', 'reason'].includes(k) && (typeof val === 'string' || typeof val === 'number')) {
            opts[k] = String(val)
          }
        }
        const item = generateArsenal(kind, opts)
        if ('error' in item) {
          const catalog = arsenalCatalog().map((k) => `${k.id}(${k.fields.map((f) => f.key).join(',') || 'no args'})`).join(' ')
          await refuse({ ok: false, kind: 'parse_error', reason: item.error, fix: `valid kinds: ${catalog}`, auditKind: 'parse_error', verdict: 'refused' })
          messages.push({ role: 'assistant', content: echo(action) })
          messages.push({ role: 'user', content: `OBSERVATION: GUARD REFUSED — ${item.error}. Valid kinds: ${catalog}` })
          break
        }
        await input.emit({ type: 'agent_thought', text: `arsenal: generated ${item.title}` })
        messages.push({ role: 'assistant', content: echo(action) })
        messages.push({
          role: 'user',
          content: `OBSERVATION (generate_payload — ${item.title}):
${item.output}
NOTES: ${item.notes}${item.caveats ? `
CAVEATS: ${item.caveats}` : ''}${item.handler ? `
HANDLER (run on your side FIRST): ${item.handler}` : ''}
Executing any of this goes through shell + the full guard chain.`,
        })
        break
      }
      case 'flag_honeypot': {
        const target = String(action.target ?? lastTarget ?? 'unknown')
        const score = Math.max(0, Math.min(100, Number(action.score ?? 0)))
        const signals = Array.isArray(action.signals) ? action.signals.map(String) : []
        const strategy = String(action.strategy ?? 'route around — deprioritize, avoid credential attacks, note in report')
        const threshold = charter.deception.honeypot_threshold
        const verdict = score >= threshold ? 'likely_honeypot' : score >= threshold / 2 ? 'possible' : 'clean'
        await input.emit({ type: 'honeypot', analysis: { target, score, threshold, verdict, signals: signals.map((s) => ({ name: 'agent', weight: 0, detail: s })), strategy } })
        await audit('honeypot_flagged', { target, score, verdict, signals, by: 'agent' }, { mode, actor: 'agent', verdict: 'info' })
        await saveFinding({
          kind: 'honeypot', title: `Honeypot flag: ${target} (${verdict})`,
          detail: `score ${score}/100 (threshold ${threshold}). signals: ${signals.join('; ')}. strategy: ${strategy}`,
          severity: 'info', honeypotScore: score, sessionId: input.sessionId, engagementId: input.engagement?.id ?? null,
        }, input.emit)
        findingTitles.push(`honeypot:${target}`)
        messages.push({ role: 'assistant', content: echo(action) })
        messages.push({ role: 'user', content: `OBSERVATION: honeypot flag recorded for ${target} (score ${score}, ${verdict}). Continue per your strategy — route around it.` })
        break
      }
      case 'note_finding': {
        const f: FindingInput = {
          kind: String(action.kind ?? 'info'),
          title: String(action.title ?? 'finding').slice(0, 160),
          detail: String(action.detail ?? '').slice(0, 4000),
          severity: (['info', 'low', 'medium', 'high', 'critical'].includes(String(action.severity)) ? action.severity : 'info') as any,
          sessionId: input.sessionId,
          engagementId: input.engagement?.id ?? null,
        }
        await saveFinding(f, input.emit)
        findingTitles.push(f.title)
        messages.push({ role: 'assistant', content: echo(action) })
        messages.push({ role: 'user', content: 'OBSERVATION: finding recorded. Continue.' })
        break
      }
      case 'run_check': {
        const check = String(action.check ?? '')
        const target = String(action.target ?? '')
        lastTarget = target
        if (!['ping', 'nslookup', 'whatweb', 'curl'].includes(check)) {
          await refuse({ ok: false, kind: 'mode_violation', reason: `run_check has exactly four checks: ping, nslookup, whatweb, curl (got "${check}")`, auditKind: 'mode_violation', verdict: 'refused' })
          messages.push({ role: 'assistant', content: echo(action) })
          messages.push({ role: 'user', content: 'OBSERVATION: GUARD REFUSED — run_check accepts only ping, nslookup, whatweb or curl.' })
          break
        }
        await input.emit({ type: 'action', tool: 'run_check', check, target, reason: String(action.reason ?? '') })
        actions.push({ tool: `run_check:${check}`, command: `${check} ${target}` })
        const outcome = await runGuardedCheck(check as GuardedCheck, target, {
          sessionId: input.sessionId, mode, emit: input.emit, engagementTarget: input.engagement?.target,
        })
        const observation = await processOutcome(outcome, input, { target, mode, charterEnabled: mode !== 'unrestricted' })
        messages.push({ role: 'assistant', content: echo(action) })
        messages.push({ role: 'user', content: obs(`OBSERVATION (${check} → ${target}):\n${observation}`) })
        if (isStopRequested(input.sessionId) || isKillSwitchEngaged()) {
          if (await interruptNow()) break loop
        }
        break
      }
      case 'shell': {
        const command = String(action.command ?? '').trim()
        const reason = String(action.reason ?? '')
        if (!command) {
          await refuse({ ok: false, kind: 'parse_error', reason: 'empty shell command', auditKind: 'parse_error', verdict: 'refused' })
          messages.push({ role: 'assistant', content: echo(action) })
          messages.push({ role: 'user', content: 'OBSERVATION: GUARD REFUSED — empty command.' })
          break
        }
        ;(input as any).__lastCommand = command
        await input.emit({ type: 'action', tool: 'shell', command, reason })
        actions.push({ tool: 'shell', command })
        const outcome = await runTool({
          sessionId: input.sessionId,
          tool: 'shell',
          label: command.split(/\s+/)[0],
          command,
          targetHost: undefined, // egress handled per-host inside the wrapper
          mode,
          engagementId: input.engagement?.id,
          engagementTarget: input.engagement?.target,
          emit: input.emit,
          timeoutMs: resolveTimeoutMs(action.timeoutMs, msLeft, endurance ? 3_600_000 : 600_000),
        })
        const observation = await processOutcome(outcome, input, { target: lastTarget, mode, charterEnabled: mode !== 'unrestricted' })
        let shellObservation = observation
        if (outcome.ok) {
          const label = command.split(/\s+/)[0]?.toLowerCase() ?? 'shell'
          const errored = outcome.result.exitCode != null && outcome.result.exitCode !== 0
          const failed = errored || outcome.result.timedOut
          // auto-learn: capture the failure signature so future turns avoid it
          // (pure timeouts aren't syntax mistakes — their output is partial results)
          if (errored && outcome.result.output) {
            void recordMistake({ tool: label, command, errorHead: outcome.result.output.slice(0, 400) }).catch(() => {})
          }
          // knowledge hint for the NEXT step — failures only (retrieval at
          // the moment of need keeps successful steps lean)
          if (failed) {
            const hintText = outcome.result.timedOut ? 'command TIMED OUT killed at timeout limit' : outcome.result.output
            const hint = await createCommandHint(label, outcome.result.exitCode ?? 1, hintText).catch(() => '')
            if (hint) shellObservation += `\n[KNOWLEDGE] ${hint.slice(0, 300)}`
          }
        }
        messages.push({ role: 'assistant', content: echo(action) })
        messages.push({ role: 'user', content: obs(`OBSERVATION (shell):\n${shellObservation}`) })
        if (isStopRequested(input.sessionId) || isKillSwitchEngaged()) {
          if (await interruptNow()) break loop
        }
        break
      }
      case 'shell_batch': {
        // parallel fan-out of INDEPENDENT commands (recon). Each command
        // still passes the full five-step wrapper chain on its own — the
        // batch only shares one step of the turn budget.
        const batch = planBatch(action.commands, { charterMax: charter.rules_of_engagement.max_concurrent_actions })
        if (!batch.ok) {
          await refuse({ ok: false, kind: 'parse_error', reason: batch.reason, fix: batch.fix, auditKind: 'parse_error', verdict: 'refused' })
          messages.push({ role: 'assistant', content: echo(action) })
          messages.push({ role: 'user', content: `OBSERVATION: GUARD REFUSED — ${batch.reason}${batch.fix ? `\nFIX: ${batch.fix}` : ''}` })
          break
        }
        const cmds = batch.plan.commands
        // one rate pre-check so an over-limit batch doesn't fan out into N refusals
        // (each runTool still does its own check + records its own action)
        const rl = endurance ? null : checkRateLimit(charter)
        if (rl) {
          await refuse(rl)
          messages.push({ role: 'assistant', content: echo(action) })
          messages.push({ role: 'user', content: `OBSERVATION: GUARD REFUSED — ${rl.reason}${rl.fix ? `\nFIX: ${rl.fix}` : ''}` })
          break
        }
        ;(input as any).__lastCommand = cmds.join(' ; ')
        await input.emit({ type: 'action', tool: 'shell_batch', command: cmds.join(' ∥ '), reason: String(action.reason ?? 'parallel recon') })
        const results = await Promise.all(cmds.map(async (command): Promise<BatchResult> => {
          actions.push({ tool: 'shell', command })
          const outcome = await runTool({
            sessionId: input.sessionId,
            tool: 'shell',
            label: command.split(/\s+/)[0],
            command,
            targetHost: undefined, // egress handled per-host inside the wrapper
            mode,
            engagementId: input.engagement?.id,
            engagementTarget: input.engagement?.target,
            emit: input.emit,
            timeoutMs: resolveTimeoutMs(action.timeoutMs, msLeft, endurance ? 3_600_000 : 600_000),
          })
          if (!outcome.ok) return { command, exitCode: null, output: '', refused: `${outcome.kind}: ${outcome.reason}` }
          const label = command.split(/\s+/)[0]?.toLowerCase() ?? 'shell'
          const errored = outcome.result.exitCode != null && outcome.result.exitCode !== 0
          const failed = errored || outcome.result.timedOut
          if (errored && outcome.result.output) {
            void recordMistake({ tool: label, command, errorHead: outcome.result.output.slice(0, 400) }).catch(() => {})
          }
          const hintText = failed ? (outcome.result.timedOut ? 'command TIMED OUT killed at timeout limit' : outcome.result.output) : ''
          const hint = failed ? await createCommandHint(label, outcome.result.exitCode ?? 1, hintText).catch(() => '') : ''
          return { command, exitCode: outcome.result.exitCode, output: outcome.result.output, timedOut: outcome.result.timedOut, hint: hint ? hint.slice(0, 300) : undefined }
        }))
        messages.push({ role: 'assistant', content: echo(action) })
        messages.push({ role: 'user', content: obs(`OBSERVATION (shell_batch — ${cmds.length} commands ran in parallel, each fully guarded):\n${formatBatchObservation(results)}`) })
        if (isStopRequested(input.sessionId) || isKillSwitchEngaged()) {
          if (await interruptNow()) break loop
        }
        break
      }
      default: {
        await refuse({
          ok: false, kind: 'parse_error',
          reason: `unknown tool "${tool}"`,
          fix: 'Valid actions: final, get_tool_strategy, flag_honeypot, note_finding, run_check, shell. To run a program, use {"tool":"shell","command":"<program> <args>"}',
          auditKind: 'parse_error', verdict: 'refused',
        })
        messages.push({ role: 'assistant', content: echo(action) })
        messages.push({ role: 'user', content: `OBSERVATION: GUARD REFUSED — unknown tool "${tool}". Program names (nmap, masscan, ping, dig, curl...) are NOT action names. To run one, emit exactly {"tool":"shell","command":"<program> <args>"} — e.g. {"tool":"shell","command":"nmap -Pn -p 80,443 <host>"}. Valid actions: final, get_tool_strategy, flag_honeypot, note_finding, run_check, shell.` })
      }
    }
  }

  if (!finalText) {
    finalText = `I used my step budget (${maxSteps}) without reaching a final. Progress so far:\n${summarize(actions, refusals, findingTitles)}\nSay "continue" to keep going from here.`
  }

  await input.emit({ type: 'final', text: finalText })
  await db.chatMessage.create({
    data: {
      sessionId: input.sessionId,
      role: 'assistant',
      content: finalText,
      meta: JSON.stringify({ steps: stepsUsed, actions: actions.slice(0, 40), refusals: refusals.slice(0, 15), findings: findingTitles.slice(0, 20), mode, turnId }),
    },
  })
  await db.chatSession.update({ where: { id: input.sessionId }, data: { mode, updatedAt: new Date() } }).catch(() => {})
  await input.emit({ type: 'agent_end', turnId, steps: stepsUsed })
}

async function processOutcome(
  outcome: { ok: true; result: { output: string; exitCode: number | null; durationMs: number; timedOut: boolean } } | GuardRefusal,
  input: TurnInput,
  ctx: { target?: string; mode: Mode; charterEnabled: boolean }
): Promise<string> {
  if (!outcome.ok) {
    return `GUARD REFUSED (${outcome.kind}): ${outcome.reason}${outcome.fix ? `\nFIX: ${outcome.fix}` : ''}\nAdapt to this — do not repeat the same attempt.` as string
  }
  const { output, exitCode, timedOut } = outcome.result
  // Behavioral honeypot heuristics run on every scan-ish output.
  if (ctx.target) {
    const analysis = analyzeText(ctx.target, output)
    if (analysis && analysis.verdict !== 'clean') {
      await input.emit({ type: 'honeypot', analysis })
      await audit('honeypot_flagged', { target: analysis.target, score: analysis.score, verdict: analysis.verdict, by: 'heuristic' }, { mode: ctx.mode, actor: 'system', verdict: 'info' })
      await saveFinding({
        kind: 'honeypot',
        title: `Honeypot heuristic: ${analysis.target} (${analysis.verdict})`,
        detail: `score ${analysis.score}/100. signals: ${analysis.signals.map((s) => s.name).join(', ')}. strategy: ${analysis.strategy}`,
        severity: 'info', honeypotScore: analysis.score, sessionId: input.sessionId, engagementId: input.engagement?.id ?? null,
      }, input.emit)
    }
  }
  const body = tail(output)
  return `exit=${exitCode ?? 'none'}${timedOut ? ' (TIMED OUT)' : ''}\n${body || '(no output)'}`
}

function summarize(actions: { tool: string; command?: string; exit?: number | null }[], refusals: string[], findings: string[]): string {
  const parts: string[] = []
  parts.push(`actions so far: ${actions.length}`)
  for (const a of actions.slice(-6)) parts.push(`- [${a.tool}] ${a.command ?? ''}${a.exit !== undefined ? ` (exit ${a.exit})` : ''}`)
  if (refusals.length) parts.push(`guard refusals: ${refusals.length} (${Array.from(new Set(refusals.map((r) => r.split(':')[0]))).join(', ')})`)
  if (findings.length) parts.push(`findings: ${findings.slice(-8).join('; ')}`)
  return parts.join('\n')
}
