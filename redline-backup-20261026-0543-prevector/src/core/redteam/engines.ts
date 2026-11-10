// ─────────────────────────────────────────────────────────────────────────────
// Engagement engine — executes the plan through the same guarded wrapper the
// chat agent uses (nothing here spawns a process directly). Two runners:
//   heuristic — deterministic: picks tools via the strategy board, composes
//               commands from templates, parses findings
//   agent     — hands each phase to the LLM orchestrator for adaptive work
// Both record findings, run honeypot heuristics, respect the charter ladder,
// and end with a full markdown report.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '../db'
import { audit } from '../audit'
import { loadCharter, resolveTarget } from '../charter'
import { getSettings } from '../settings'
import { runTool } from '../wrapper'
import { whichBin } from '../os'
import { getRegistry, warmRegistry } from '../tools/registry'
import { selectStrategy } from '../tools/selector'
import { TASK_TEMPLATES, templateById } from './killchain'
import { estimateFootprint, FOOTPRINT_LABEL, profilePolicy } from './footprint'
import { analyzeText } from './honeypot'
import { runTurn } from '../agent/orchestrator'
import type { AgentEvent, EmitFn, FindingInput, Mode } from '../types'

export interface CreateEngagementInput {
  target: string
  objective: string
  profile: 'stealth' | 'balanced' | 'fast'
  domains: string[]
  mode: Mode
}

function pad(n: number, w = 3) {
  return String(n).padStart(w, '0')
}

export async function createEngagement(input: CreateEngagementInput) {
  const charter = loadCharter()
  const res = await resolveTarget(charter, input.target)
  if (!res.ok) {
    return { ok: false as const, error: `target "${input.target}" failed the charter check: ${res.reason}`, fix: res.fix }
  }
  const count = await db.engagement.count()
  const eid = `ENG-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${pad(count + 1)}`
  const { planEngagement, planTasksFlat } = await import('./planner')
  const plan = planEngagement({ target: input.target, objective: input.objective, profile: input.profile, domains: input.domains })
  const engagement = await db.engagement.create({
    data: {
      eid,
      target: input.target,
      objective: input.objective,
      profile: input.profile,
      domains: JSON.stringify(input.domains),
      status: 'planned',
      phase: 'recon',
      plan: JSON.stringify(plan),
      runner: 'heuristic',
      modeAtStart: input.mode,
    },
  })
  const flat = planTasksFlat(plan)
  const templateByTitle = new Map(TASK_TEMPLATES.map((t) => [t.title, t]))
  for (const t of flat) {
    const tmpl = templateByTitle.get(t.title)
    await db.engagementTask.create({
      data: {
        engagementId: engagement.id,
        title: t.title,
        phase: t.phase,
        domain: t.domain,
        parallelGroup: t.parallelGroup,
        toolHint: t.toolHint ?? null,
      },
    })
    void tmpl
  }
  await audit('engagement_started', { eid, target: input.target, profile: input.profile, domains: input.domains, tasks: flat.length }, { actor: 'operator', mode: input.mode, verdict: 'allowed' })
  return { ok: true as const, engagement, plan }
}

// ─── findings parsing ────────────────────────────────────────────────────────

async function saveFinding(f: FindingInput) {
  return db.finding.create({
    data: {
      kind: f.kind, title: f.title, detail: f.detail, severity: f.severity ?? 'info',
      engagementId: f.engagementId ?? null, sessionId: f.sessionId ?? null,
      honeypotScore: f.honeypotScore ?? null, evidence: f.evidence ?? null,
    },
  })
}

async function parseFindings(engagementId: number, target: string, taskTitle: string, output: string, emit: EmitFn) {
  const saved: string[] = []

  // open ports + services (nmap style)
  const portRe = /^(\d{1,5})\/(tcp|udp)\s+open\s+(\S+)(?:\s+(.+))?$/gm
  const ports: { port: number; svc: string; version?: string }[] = []
  let m: RegExpExecArray | null
  while ((m = portRe.exec(output))) ports.push({ port: Number(m[1]), svc: m[3], version: m[4]?.trim() })
  if (ports.length) {
    const top = ports.slice(0, 40)
    await saveFinding({
      kind: 'open_port', engagementId,
      title: `${ports.length} open port${ports.length > 1 ? 's' : ''} on ${target} (${taskTitle})`,
      detail: top.map((p) => `${p.port}/${p.svc}${p.version ? ` — ${p.version}` : ''}`).join('\n'),
      severity: ports.some((p) => [3389, 445, 1433, 3306, 6379, 27017, 9200].includes(p.port)) ? 'medium' : 'low',
      evidence: top.map((p) => `${p.port} ${p.svc}`).join(',').slice(0, 500),
    })
    saved.push('open_port')
    for (const p of ports.filter((x) => x.version).slice(0, 10)) {
      await saveFinding({
        kind: 'service', engagementId,
        title: `Service on ${target}:${p.port} — ${p.svc} (${p.version!.slice(0, 60)})`,
        detail: `banner/version: ${p.version}`, severity: 'info',
      })
    }
    await emit({ type: 'finding', finding: { kind: 'open_port', title: `${ports.length} open ports on ${target}`, detail: top.map((p) => p.port).join(', ').slice(0, 300), severity: 'low', engagementId } })
  }

  // nuclei: [critical] [cve-2020-xxxx] [http] [target]
  const nucRe = /\[(critical|high|medium|low|info)\]\s+\[([^\]]+)\]/gi
  const vulns: { sev: string; id: string }[] = []
  while ((m = nucRe.exec(output))) vulns.push({ sev: m[1].toLowerCase(), id: m[2] })
  for (const v of vulns.slice(0, 25)) {
    await saveFinding({
      kind: 'vuln', engagementId,
      title: `${v.id} (${v.sev}) on ${target}`,
      detail: `detected by template scan (${taskTitle})`,
      severity: (['info', 'low', 'medium', 'high', 'critical'].includes(v.sev) ? v.sev : 'info') as any,
    })
    saved.push('vuln')
    await emit({ type: 'finding', finding: { kind: 'vuln', title: `${v.id} (${v.sev}) on ${target}`, detail: 'template scan', severity: v.sev as any, engagementId } })
  }

  // whatweb tech
  if (/whatweb|HTTPServer|X-Powered-By/i.test(output)) {
    const techs = Array.from(new Set((output.match(/\[([A-Z][A-Za-z0-9.# -]{2,30})\]/g) ?? []).map((s) => s.slice(1, -1)))).filter((t) => !/^\d/.test(t))
    if (techs.length) {
      await saveFinding({
        kind: 'tech', engagementId,
        title: `Technologies on ${target}: ${techs.slice(0, 12).join(', ')}`,
        detail: techs.join(', '), severity: 'info', evidence: taskTitle,
      })
      saved.push('tech')
    }
  }

  // web alive
  const code = output.match(/http_code=(\d{3})/)
  if (code && code[1].startsWith('2') || code?.[1] === '301' || code?.[1] === '302') {
    await saveFinding({ kind: 'exposure', engagementId, title: `Web service live on ${target} (HTTP ${code?.[1]})`, detail: `responding (${taskTitle})`, severity: 'info' })
    saved.push('exposure')
  }
  return saved
}

// ─── the runner ──────────────────────────────────────────────────────────────

const running = new Set<number>()

export function isEngagementRunning(id: number) {
  return running.has(id)
}

export async function runEngagement(
  engagementId: number,
  opts: { runner?: 'heuristic' | 'agent'; emit: EmitFn }
): Promise<{ ok: boolean; error?: string }> {
  if (running.has(engagementId)) return { ok: false, error: 'engagement is already running' }
  const settings = await getSettings()
  const mode = settings.mode
  const emit = opts.emit
  const runner = opts.runner ?? 'heuristic'

  const engagement = await db.engagement.findUnique({ where: { id: engagementId }, include: { tasks: true } })
  if (!engagement) return { ok: false, error: 'engagement not found' }
  if (engagement.status === 'running') return { ok: false, error: 'engagement is already running' }

  running.add(engagementId)
  await db.engagement.update({ where: { id: engagementId }, data: { status: 'running', runner } })

  try {
    await warmRegistry()
    const charter = loadCharter()
    const policy = profilePolicy(engagement.profile as any)
    const started = Date.now()
    const timeBudgetMs = charter.rules_of_engagement.time_budget_minutes * 60_000
    const priority = engagement.profile === 'fast' ? 'speed' : engagement.profile === 'stealth' ? 'stealth' : 'balanced'

    // order: phase order, then group order
    const order: Phase[] = ['recon', 'enumeration', 'vuln_analysis', 'exploitation', 'post_exploit']
    const tasks = engagement.tasks.sort((a, b) => {
      const pd = order.indexOf(a.phase as Phase) - order.indexOf(b.phase as Phase)
      return pd !== 0 ? pd : a.parallelGroup - b.parallelGroup || a.id - b.id
    })

    let ladderBroken = false

    // one task start to finish (template → gates → agent/heuristic execution).
    // ladderBroken only mutates from rung templates (exploitation ladder) —
    // recon/enumeration templates carry no rungs, so parallel lanes are safe.
    const runOneTask = async (task: (typeof tasks)[number]) => {
      const tmpl = templateById(TASK_TEMPLATES.find((t) => t.title === task.title)?.id ?? '') ?? TASK_TEMPLATES.find((t) => t.title === task.title)
      if (!tmpl) {
        await db.engagementTask.update({ where: { id: task.id }, data: { status: 'skipped', summary: 'no template' } })
        return
      }

      // ladder gates
      if (tmpl.rung) {
        if (tmpl.rung > charter.exploitation.max_rung || (tmpl.rung >= 4 && !charter.exploitation.replica_host)) {
          await db.engagementTask.update({
            where: { id: task.id },
            data: { status: 'skipped', summary: `ladder gate: rung ${tmpl.rung} blocked (charter max_rung=${charter.exploitation.max_rung}${!charter.exploitation.replica_host ? ', no replica_host' : ''})` },
          })
          return
        }
        if (ladderBroken) {
          await db.engagementTask.update({ where: { id: task.id }, data: { status: 'skipped', summary: 'lower rung failed — the safest-first ladder stops escalating' } })
          return
        }
      }

      await db.engagementTask.update({ where: { id: task.id }, data: { status: 'running', startedAt: new Date() } })

      // ── agent runner: hand the phase to the orchestrator ──
      if (runner === 'agent') {
        const strategy = selectStrategy(tmpl.toolTask, { priority: priority as any })
        await db.engagementTask.update({ where: { id: task.id }, data: { strategy: JSON.stringify({ primary: strategy.primary, ranked: strategy.ranked.slice(0, 3) }) } })
        await runTurn({
          sessionId: `eng-${engagementId}-${task.id}`,
          mode,
          emit,
          engagement: { id: engagementId, target: engagement.target },
          userText: `ENGAGEMENT ${engagement.eid} — execute this task against ${engagement.target} ONLY:\n"${task.title}" (domain: ${task.domain}, phase: ${task.phase})\nObjective context: ${engagement.objective}\nStrategy hint: ${strategy.guidance}\nWork the task with the tools you have, then call final with what you found. Record findings with note_finding. Honor the footprint policy: ${policy.guidance}`,
          isContinuation: true,
        })
        await db.engagementTask.update({ where: { id: task.id }, data: { status: 'done', finishedAt: new Date(), footprint: 3 } })
        return
      }

      // ── heuristic runner: strategy board picks the tool ──
      const strategy = selectStrategy(tmpl.toolTask, { priority: priority as any })
      await db.engagementTask.update({ where: { id: task.id }, data: { strategy: JSON.stringify({ primary: strategy.primary, ranked: strategy.ranked.slice(0, 3), complement: strategy.complement }) } })

      // choose the first template command whose binary is actually available,
      // ordered by the strategy ranking
      const rankedBins = new Set(strategy.ranked.map((c) => c.name.toLowerCase()))
      const sortedCmds = [...tmpl.commands].sort((a, b) => {
        const ra = rankedBins.has(a.bin.toLowerCase()) ? 0 : 1
        const rb = rankedBins.has(b.bin.toLowerCase()) ? 0 : 1
        return ra - rb
      })
      const choice = sortedCmds.find((c) => whichBin(c.bin))
      if (!choice) {
        await db.engagementTask.update({
          where: { id: task.id },
          data: {
            status: 'tool_unavailable',
            finishedAt: new Date(),
            summary: `no available tool for "${tmpl.toolTask}" — install one from the Marketplace (tried: ${sortedCmds.map((c) => c.bin).join(', ')})`,
          },
        })
        return
      }

      const tpl = engagement.profile === 'stealth' && choice.stealthTemplate ? choice.stealthTemplate : choice.template
      const command = tpl.replace(/\{target\}/g, engagement.target)
      const footprint = Math.max(estimateFootprint(command), 1)
      const cap = policy.maxFootprint[task.phase as keyof typeof policy.maxFootprint] ?? 4
      const cappedNote = footprint > cap ? ` (footprint ${FOOTPRINT_LABEL[footprint - 1]} exceeds ${engagement.profile} cap — consider the stealth variant)` : ''

      const outcome = await runTool({
        sessionId: `eng-${engagementId}`,
        tool: choice.bin,
        label: `${task.title} [${choice.bin}]`,
        command,
        targetHost: engagement.target,
        mode,
        engagementId,
        engagementTarget: engagement.target,
        emit,
      })

      if (!outcome.ok) {
        await db.engagementTask.update({
          where: { id: task.id },
          data: { status: 'refused', finishedAt: new Date(), output: outcome.reason.slice(0, 2000), summary: `${outcome.kind}: ${outcome.reason.slice(0, 200)}`, footprint },
        })
        if (tmpl.rung && (outcome.kind === 'approval_denied' || outcome.kind === 'approval_timeout')) ladderBroken = true
        return
      }

      const { output, exitCode } = outcome.result
      // findings + honeypot heuristics on the real output
      await parseFindings(engagementId, engagement.target, task.title, output, emit)
      const hp = analyzeText(engagement.target, output, charter.deception.honeypot_threshold)
      if (hp && hp.verdict !== 'clean') {
        await emit({ type: 'honeypot', analysis: hp })
        await audit('honeypot_flagged', { target: hp.target, score: hp.score, verdict: hp.verdict, by: 'heuristic' }, { mode, actor: 'system', verdict: 'info' })
        await saveFinding({
          kind: 'honeypot', engagementId,
          title: `Honeypot heuristic: ${hp.target} (${hp.verdict})`,
          detail: `score ${hp.score}/100 — ${hp.signals.map((s) => s.name).join(', ')}. ${hp.strategy}`,
          severity: 'info', honeypotScore: hp.score,
        })
      }

      const failed = (exitCode !== null && exitCode !== 0 && output.trim().length === 0)
      if (failed && tmpl.rung) ladderBroken = true
      await db.engagementTask.update({
        where: { id: task.id },
        data: {
          status: failed ? 'failed' : 'done',
          finishedAt: new Date(),
          output: output.slice(0, 6000),
          summary: `exit=${exitCode} · ${choice.bin} · footprint ${FOOTPRINT_LABEL[footprint - 1]}${cappedNote}`,
          footprint,
        },
      })
    }

    // concurrency knob: the charter's max_concurrent_actions (1 = sequential,
    // the default). Recon/enumeration lanes with the same parallelGroup run
    // together; later phases and agent-runner turns stay sequential.
    const concurrency = Math.max(1, Math.min(8, charter.rules_of_engagement.max_concurrent_actions ?? 1))
    let i = 0
    while (i < tasks.length) {
      // abort / budget checks between task groups
      const fresh = await db.engagement.findUnique({ where: { id: engagementId } })
      if (!fresh || fresh.status === 'aborted') break
      if (Date.now() - started > timeBudgetMs) {
        await db.engagementTask.updateMany({ where: { engagementId, status: 'pending' }, data: { status: 'skipped' } })
        break
      }
      const task = tasks[i]
      await db.engagement.update({ where: { id: engagementId }, data: { phase: task.phase } })

      const group: (typeof tasks)[number][] = [task]
      if (runner !== 'agent' && concurrency >= 2 && (task.phase === 'recon' || task.phase === 'enumeration')) {
        while (i + group.length < tasks.length) {
          const nxt = tasks[i + group.length]
          if (nxt.phase !== task.phase || nxt.parallelGroup !== task.parallelGroup) break
          group.push(nxt)
        }
      }
      if (group.length > 1) {
        await emit({ type: 'agent_thought', text: `parallel lane ${task.parallelGroup} (${task.phase}): ${group.length} tasks running concurrently` })
        await Promise.all(group.map((t) => runOneTask(t)))
      } else {
        await runOneTask(task)
      }
      i += group.length
    }

    const finalStatus = (await db.engagement.findUnique({ where: { id: engagementId } }))?.status ?? 'done'
    if (finalStatus !== 'aborted') {
      await db.engagement.update({ where: { id: engagementId }, data: { status: 'done', phase: 'reporting' } })
    }
    await audit('engagement_completed', { eid: engagement.eid, target: engagement.target, runner }, { mode, actor: 'system', verdict: 'info' })
    return { ok: true }
  } catch (e: any) {
    await db.engagement.update({ where: { id: engagementId }, data: { status: 'aborted' } }).catch(() => {})
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    running.delete(engagementId)
  }
}

export async function stopEngagement(id: number) {
  await db.engagement.update({ where: { id }, data: { status: 'aborted' } })
  await audit('engagement_completed', { id, action: 'aborted' }, { actor: 'operator', verdict: 'info' })
}

export async function stopAllEngagements() {
  for (const id of Array.from(running)) {
    await stopEngagement(id).catch(() => {})
  }
}

// ─── report generation ───────────────────────────────────────────────────────

export async function generateReport(engagementId: number): Promise<string> {
  const e = await db.engagement.findUnique({ where: { id: engagementId }, include: { tasks: true, findings: true } })
  if (!e) return '# Engagement not found'
  const sevOrder = ['critical', 'high', 'medium', 'low', 'info']
  const bySeverity = new Map<string, typeof e.findings>()
  for (const f of e.findings) {
    const arr = bySeverity.get(f.severity) ?? []
    arr.push(f)
    bySeverity.set(f.severity, arr)
  }
  const done = e.tasks.filter((t) => t.status === 'done').length
  const refused = e.tasks.filter((t) => t.status === 'refused').length
  const skipped = e.tasks.filter((t) => t.status === 'skipped' || t.status === 'tool_unavailable').length
  const honeypots = e.findings.filter((f) => f.kind === 'honeypot')
  const footprintTotal = e.tasks.reduce((s, t) => s + (t.footprint ?? 0), 0)

  const lines: string[] = []
  lines.push(`# REDLINE Engagement Report — ${e.eid}`)
  lines.push('')
  lines.push(`**Target**: ${e.target} · **Objective**: ${e.objective}`)
  lines.push(`**Profile**: ${e.profile} · **Mode at start**: ${e.modeAtStart} · **Runner**: ${e.runner}`)
  lines.push(`**Status**: ${e.status} · **Window**: ${e.createdAt.toISOString()} → ${e.updatedAt.toISOString()}`)
  lines.push('')
  lines.push('## Executive summary')
  lines.push('')
  lines.push(`- Tasks: ${done}/${e.tasks.length} completed, ${refused} guard-refused, ${skipped} skipped/gated`)
  lines.push(`- Findings: ${e.findings.length} total — ${sevOrder.map((s) => `${(bySeverity.get(s) ?? []).length} ${s}`).join(', ')}`)
  lines.push(`- Deception: ${honeypots.length} honeypot flag${honeypots.length === 1 ? '' : 's'}`)
  lines.push(`- Footprint accounting: ${footprintTotal} task-footprint points across ${e.tasks.filter((t) => t.footprint).length} executed tasks`)
  lines.push('')
  lines.push('## Methodology (kill chain)')
  lines.push('')
  for (const phase of ['recon', 'enumeration', 'vuln_analysis', 'exploitation', 'post_exploit', 'reporting']) {
    const ts = e.tasks.filter((t) => t.phase === phase)
    if (!ts.length) continue
    lines.push(`### ${phase}`)
    for (const t of ts) {
      lines.push(`- [${t.status}] ${t.title} — ${t.summary ?? ''}`)
    }
  }
  lines.push('')
  lines.push('## Findings')
  for (const sev of sevOrder) {
    const fs = bySeverity.get(sev)
    if (!fs?.length) continue
    lines.push('')
    lines.push(`### ${sev.toUpperCase()} (${fs.length})`)
    for (const f of fs) {
      lines.push(`- **${f.title}** — ${f.detail.slice(0, 600)}`)
    }
  }
  if (honeypots.length) {
    lines.push('')
    lines.push('## Deception & honeypots')
    for (const h of honeypots) {
      lines.push(`- ${h.title} (score ${h.honeypotScore ?? '?'}/100) — route-around strategy recorded`)
    }
  }
  lines.push('')
  lines.push('## Footprint accounting')
  lines.push('')
  for (const t of e.tasks.filter((t) => t.footprint)) {
    lines.push(`- ${t.title}: ${FOOTPRINT_LABEL[(t.footprint ?? 3) - 1]} (${t.footprint}/5)`)
  }
  lines.push('')
  lines.push('## Guard activity')
  lines.push('')
  lines.push(`- ${refused} task${refused === 1 ? '' : 's'} were guard-refused — every refusal is auditable evidence the guard worked.`)
  lines.push('')
  lines.push('## Recommended remediation priorities')
  lines.push('')
  const topVulns = e.findings.filter((f) => ['critical', 'high'].includes(f.severity))
  if (topVulns.length) {
    for (const v of topVulns.slice(0, 10)) lines.push(`1. ${v.title} — ${v.detail.slice(0, 200)}`)
  } else {
    lines.push('No critical/high findings recorded. Maintain patch hygiene and continue monitoring.')
  }
  lines.push('')
  lines.push('_Generated by REDLINE — authorized engagement under lab/charter.yaml. All actions were gated, streamed and audited._')
  return lines.join('\n')
}

type Phase = 'recon' | 'enumeration' | 'vuln_analysis' | 'exploitation' | 'post_exploit' | 'reporting'
