// Audit trail — every gate verdict, every command, every refusal is auditable
// evidence that the guard worked. The socket service registers a sink so the
// Audit page live-streams events.
import { db } from './db'
import { getMode } from './settings'
import type { Mode } from './types'

export interface AuditDetail { [k: string]: unknown }

type AuditSink = (event: {
  id: number
  ts: Date
  kind: string
  mode: string
  actor: string
  verdict: string | null
  detail: string
}) => void

let sink: AuditSink | null = null

export function setAuditSink(fn: AuditSink | null) {
  sink = fn
}

export async function audit(
  kind: string,
  detail: AuditDetail,
  opts: { actor?: string; mode?: Mode | string; verdict?: string } = {}
): Promise<void> {
  const mode = (opts.mode as string) ?? (await getMode())
  const row = await db.auditEvent.create({
    data: {
      kind,
      mode,
      actor: opts.actor ?? 'system',
      verdict: opts.verdict ?? 'info',
      detail: JSON.stringify(detail),
    },
  })
  try {
    sink?.({
      id: row.id,
      ts: row.ts,
      kind: row.kind,
      mode: row.mode,
      actor: row.actor,
      verdict: row.verdict,
      detail: row.detail,
    })
  } catch { /* sink failures must never break the pipeline */ }
}

export async function listAudit(opts: { limit?: number; kind?: string; mode?: string } = {}) {
  const limit = Math.min(opts.limit ?? 100, 500)
  return db.auditEvent.findMany({
    where: {
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
    },
    orderBy: { id: 'desc' },
    take: limit,
  })
}
