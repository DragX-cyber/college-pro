// ─────────────────────────────────────────────────────────────────────────────
// Smart tool selector — "use the right tool for the job".
// Scores every registry tool for a task with priority-weighted capabilities:
//   speed → masscan wins port scans; coverage/reliability → nmap wins deep work.
// A tool that is flawed for the current task keeps its pros — the strategy
// names the complement ("masscan finds the ports, nmap -sV explains them")
// and never discards a tool for being slow at one task.
// ─────────────────────────────────────────────────────────────────────────────
import { getRegistry } from './registry'
import { TASK_LABELS } from '../marketplace/catalog'
import type { Priority, ToolChoice, ToolManifest, ToolStrategy } from '../types'

const WEIGHTS: Record<Priority, { speed: number; efficiency: number; coverage: number; reliability: number }> = {
  speed: { speed: 0.45, efficiency: 0.3, coverage: 0.1, reliability: 0.15 },
  coverage: { speed: 0.15, efficiency: 0.2, coverage: 0.4, reliability: 0.25 },
  stealth: { speed: 0.1, efficiency: 0.35, coverage: 0.15, reliability: 0.4 },
  reliability: { speed: 0.15, efficiency: 0.2, coverage: 0.2, reliability: 0.45 },
  balanced: { speed: 0.25, efficiency: 0.25, coverage: 0.25, reliability: 0.25 },
}

export function scoreCapability(c: { speed: number; efficiency: number; coverage: number; reliability: number }, priority: Priority): number {
  const w = WEIGHTS[priority]
  return Math.round((c.speed * w.speed + c.efficiency * w.efficiency + c.coverage * w.coverage + c.reliability * w.reliability) * 10) / 10
}

function choiceFor(tool: ToolManifest, task: string, priority: Priority): ToolChoice {
  const c = tool.capabilities[task]!
  const score = scoreCapability(c, priority)
  const parts: string[] = []
  if (c.speed >= 8) parts.push('fast at this task')
  if (c.speed <= 3) parts.push(`slow at this task (speed ${c.speed}/10)`)
  if (c.coverage >= 9) parts.push('broad coverage')
  if (c.reliability >= 9) parts.push('highly reliable results')
  const caveat = tool.flaws.find((f) => f.context === task || tool.flaws.length)?.note
  return {
    id: tool.id,
    name: tool.name,
    score,
    speed: c.speed,
    efficiency: c.efficiency,
    coverage: c.coverage,
    reliability: c.reliability,
    rationale: `${tool.name}: ${parts.join(', ') || 'solid all-round'}; score ${score}/10 for "${TASK_LABELS[task] ?? task}" under ${priority} priority.`,
    caveat,
  }
}

export function selectStrategy(task: string, opts: { priority?: Priority } = {}): ToolStrategy {
  const priority = opts.priority ?? 'balanced'
  const registry = getRegistry()
  const candidates = registry.filter((t) => t.capabilities[task])
  const stealthNotes = Array.from(new Set(candidates.flatMap((t) => t.stealthNotes ?? [])))

  if (candidates.length === 0) {
    return {
      task,
      priority,
      primary: null,
      ranked: [],
      complement: null,
      avoidWhen: [],
      stealthNotes,
      guidance: `No tool in the current registry covers "${TASK_LABELS[task] ?? task}". Check the Marketplace — installing a tool makes it available to you automatically on the next action.`,
    }
  }

  const choices = candidates.map((t) => choiceFor(t, task, priority)).sort((a, b) => b.score - a.score)
  const primary = choices[0]

  // Complement: the tool with the strongest depth (coverage+reliability) that
  // beats the primary where the primary is weak (the fast tool finds, the deep
  // tool explains). This is where "masscan for speed, then nmap -sV for depth"
  // comes from — and why a slow tool is never discarded, only sequenced.
  const qualifies = (c: ToolChoice) =>
    c.id !== primary.id && (c.coverage > primary.coverage || c.reliability > primary.reliability) && (c.coverage >= 8 || c.reliability >= 8)
  const deep = choices
    .filter(qualifies)
    .sort((a, b) => (b.coverage + b.reliability) - (a.coverage + a.reliability) || b.score - a.score)[0]
  const complement = deep
    ? {
        tools: [deep.id],
        note: `${primary.name} is the fastest way to produce candidates (${primary.speed}/10 speed), but ${deep.name} is stronger on depth (${deep.coverage}/10 coverage, ${deep.reliability}/10 reliability). Best play: run ${primary.name} first to narrow the field, then feed its results to ${deep.name} for the detailed pass. Never discard ${deep.name} for being slower at this stage — its pros are exactly the next stage.`,
      }
    : null

  const avoidWhen = Array.from(
    new Set(
      candidates
        .flatMap((t) => t.flaws.map((f) => `${t.name}: avoid for ${f.context} — ${f.note}`))
        .filter((s) => candidates.some((c) => s.startsWith(c.name)))
    )
  )

  const guidance = [
    `Task: ${TASK_LABELS[task] ?? task} (priority: ${priority}).`,
    `Use ${primary.name} — ${primary.rationale}`,
    complement ? complement.note : null,
    primary.caveat ? `Watch out: ${primary.caveat}` : null,
    stealthNotes.length ? `Footprint: ${stealthNotes.slice(0, 2).join('; ')}` : null,
  ].filter(Boolean).join(' ')

  return { task, priority, primary, ranked: choices, complement, avoidWhen, stealthNotes, guidance }
}

/** One-line hint the agent can cite when composing a command. */
export function quickHint(task: string, priority: Priority = 'balanced'): string {
  const s = selectStrategy(task, { priority })
  if (!s.primary) return s.guidance
  const top = s.ranked.slice(0, 3).map((c) => `${c.name}(${c.score})`).join(' > ')
  return `${task}: ${top}${s.complement ? ` — complement: ${s.complement.tools.join(', ')}` : ''}`
}
