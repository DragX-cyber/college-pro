// ─────────────────────────────────────────────────────────────────────────────
// shell_batch planning — validation, dedupe and observation formatting for
// parallel command fan-out. Each command still passes the FULL five-step
// wrapper chain independently; this module only shapes the batch.
// ─────────────────────────────────────────────────────────────────────────────
import { loadCharter } from '../charter'

export const BATCH_HARD_CAP = 8

export interface BatchPlan {
  commands: string[]
  cap: number
}

export type BatchCheck =
  | { ok: true; plan: BatchPlan }
  | { ok: false; reason: string; fix?: string }

/**
 * Validate a model-emitted batch. Concurrency cap comes from the charter's
 * rules_of_engagement.max_concurrent_actions (operator knob, Targets page /
 * lab/charter.yaml), hard-capped at 8.
 */
export function planBatch(raw: unknown, opts: { charterMax?: number } = {}): BatchCheck {
  const charterMax = opts.charterMax ?? loadCharter().rules_of_engagement.max_concurrent_actions ?? 1
  const cap = Math.max(1, Math.min(BATCH_HARD_CAP, Math.floor(charterMax)))
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      reason: 'shell_batch requires "commands": an array of 2+ independent commands',
      fix: '{"tool":"shell_batch","commands":["dig +short <host>","whatweb http://<host>"]}',
    }
  }
  // dedupe identical commands before fan-out (keeps the no-repeat guard honest)
  const cleaned = [...new Set(raw.map((c) => String(c ?? '').trim()).filter(Boolean))]
  if (cleaned.length < 2) {
    return {
      ok: false,
      reason: 'shell_batch needs at least 2 distinct non-empty commands',
      fix: 'a single command goes through {"tool":"shell","command":"..."} — no batch needed',
    }
  }
  if (cap < 2) {
    return {
      ok: false,
      reason: `parallel fan-out is disabled: charter max_concurrent_actions = ${cap}`,
      fix: 'raise "max concurrent actions" on the Targets page (lab/charter.yaml rules_of_engagement) to enable batches',
    }
  }
  if (cleaned.length > cap) {
    return {
      ok: false,
      reason: `batch of ${cleaned.length} commands exceeds the concurrency cap (${cap})`,
      fix: `split into batches of ≤ ${cap}, or raise max_concurrent_actions on the Targets page`,
    }
  }
  return { ok: true, plan: { commands: cleaned, cap } }
}

export interface BatchResult {
  command: string
  exitCode: number | null
  output: string
  timedOut?: boolean
  /** guard refusal text when the command never executed */
  refused?: string
  /** knowledge hint (failures rank mistake entries first) */
  hint?: string
}

/** One joined OBSERVATION for the whole batch — per-command heads share the cap. */
export function formatBatchObservation(results: BatchResult[], maxChars = 2600): string {
  const per = Math.max(300, Math.floor(maxChars / results.length))
  const parts = results.map((r, i) => {
    const head = `[${i + 1}/${results.length}] ${r.command}`
    if (r.refused) return `${head}\n  REFUSED: ${r.refused}`
    const body = r.output.replace(/\s+/g, ' ').trim().slice(0, per) || '(no output)'
    return `${head}\n  exit=${r.exitCode ?? '?'}${r.timedOut ? ' (TIMED OUT)' : ''} ${body}${r.hint ? `\n  [KNOWLEDGE] ${r.hint.slice(0, 250)}` : ''}`
  })
  let out = parts.join('\n')
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…(truncated)`
  return out
}
