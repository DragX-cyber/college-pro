#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────────────────────
// REDLINE CLI — Claude Code-style operator terminal.
//   bun cli/index.ts                (interactive REPL)
//   bun cli/index.ts --eval "..."   (one task, then exit)
//   bun cli/index.ts --cmd "/system"
//
// Same core engine as the web console: charter scope, guard pipeline,
// approval seat, audit trail — nothing bypasses the executor.
// ─────────────────────────────────────────────────────────────────────────────
import readline from 'readline'
import { readFileSync } from 'fs'
import { C, banner, box, hr, modeBadge, Spinner, truncate } from './ui'

import { getSettings, setSettings } from '../src/core/settings'
import { audit, listAudit } from '../src/core/audit'
import { detectOS } from '../src/core/os'
import { loadCharter, addHost, removeHost } from '../src/core/charter'
import { resolveApproval, flushSessionGuards } from '../src/core/guards'
import { runTurn } from '../src/core/agent/orchestrator'
import { getMarketplace, installTool, uninstallTool } from '../src/core/marketplace/manager'
import { autodetectTools } from '../src/core/marketplace/autodetect'
import { createKnowledge, deleteKnowledge, searchKnowledge, listKnowledge } from '../src/core/knowledge'
import { ingestOnlineDocs } from '../src/core/knowledge-online'
import { importDocument } from '../src/core/knowledge-import'
import { reindexKnowledge } from '../src/core/knowledge-embed'
import { getRegistry, warmRegistry } from '../src/core/tools/registry'
import { selectStrategy } from '../src/core/tools/selector'
import { createEngagement, runEngagement, stopEngagement, generateReport } from '../src/core/redteam/engines'
import { db } from '../src/core/db'
import type { AgentEvent, EmitFn, Mode } from '../src/core/types'

const SESSION = 'cli-main'
let MODE: Mode = 'free'
let busy = false
let rl: readline.Interface | null = null
let rlClosed = false

function getRl(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${C.cyan}❯${C.reset} `,
      historySize: 200,
    })
    rl.on('close', () => { rlClosed = true })
  }
  return rl
}

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    if (rlClosed || process.stdin.isTTY === false) {
      // non-interactive run (--eval/--cmd with piped stdin): deny and explain
      console.log(`${C.dim}  (non-interactive — auto-DENY; run interactively to approve)${C.reset}`)
      return resolve('')
    }
    getRl().question(prompt, (a) => resolve(a.trim()))
  })
}

// ─── event rendering ─────────────────────────────────────────────────────────
const runLabels = new Map<number, string>()
let finalStreamingStarted = false

const emit: EmitFn = async (event: AgentEvent) => {
  switch (event.type) {
    case 'agent_start':
      console.log(hr('turn', C.dim))
      console.log(`${C.dim}✻ redline engaging · ${modeBadge(event.mode)} · budget ${event.maxSteps} steps${C.reset}`)
      break
    case 'agent_thought':
      console.log(`${C.dim}${C.italic}  ⋯ ${truncate(event.text, 110)}${C.reset}`)
      break
    case 'action':
      console.log(`\n${C.cyan}▶ ${C.bold}${event.tool}${C.reset}${C.cyan}${event.tool === 'shell' ? '' : ` · ${event.check ?? ''} ${event.target ?? ''}`}${C.reset}`)
      if (event.command) console.log(`  ${C.acid}$ ${truncate(event.command, 120)}${C.reset}`)
      if (event.reason) console.log(`${C.dim}  why: ${truncate(event.reason, 100)}${C.reset}`)
      break
    case 'guard':
      console.log(box(`⛔ GUARD · ${event.refusal.kind}`, [
        event.refusal.reason,
        ...(event.refusal.fix ? [`${C.green}fix: ${event.refusal.fix}${C.reset}`] : []),
      ], C.red))
      break
    case 'approval_required': {
      console.log(box('⚠ APPROVAL REQUIRED', [
        `${C.acid}$ ${event.approval.command}${C.reset}`,
        `${C.dim}${event.approval.reason}${C.reset}`,
      ], C.amber))
      const ans = await question(`${C.amber}  approve? ${C.bold}[y/N]${C.reset} `)
      const decision = /^y(es)?$/i.test(ans) ? 'approved' : 'denied'
      await resolveApproval(event.approval.id, decision as any, 'operator(cli)')
      console.log(decision === 'approved' ? `${C.green}  ✓ approved — executing${C.reset}` : `${C.red}  ✗ denied — it never runs${C.reset}`)
      break
    }
    case 'approval_resolved':
      if (event.decision === 'expired') console.log(`${C.red}  ⏱ approval expired — command never ran${C.reset}`)
      break
    case 'output_start':
      console.log(`${C.dim}──[ ${event.label} ]${'─'.repeat(Math.max(3, 74 - event.label.length))}${C.reset}`)
      runLabels.set(event.runId, event.label)
      break
    case 'output':
      process.stdout.write(event.chunk)
      break
    case 'output_end':
      console.log(`\n${C.dim}  └ exit ${event.exitCode ?? '—'} · ${(event.durationMs / 1000).toFixed(1)}s · ${event.verdict}${C.reset}`)
      break
    case 'finding':
      console.log(`${C.yellow}● finding [${event.finding.severity ?? 'info'}] ${truncate(event.finding.title, 90)}${C.reset}`)
      break
    case 'honeypot': {
      const a = event.analysis
      console.log(box(`☠ HONEYPOT ${a.verdict === 'likely_honeypot' ? 'FLAGGED' : 'SUSPECT'} · ${a.target}`, [
        `score ${a.score}/100 (threshold ${a.threshold}) · signals: ${a.signals.map((s) => s.name).join(', ')}`,
        truncate(a.strategy, 110),
      ], C.magenta))
      break
    }
    case 'tool_strategy': {
      const s = event.strategy
      console.log(`${C.acid}◈ ${s.task}: ${s.ranked.slice(0, 3).map((c) => `${c.name}(${c.score})`).join(' > ')}${C.reset}`)
      if (s.complement) console.log(`${C.dim}  ${truncate(s.complement.note, 108)}${C.reset}`)
      break
    }
    case 'error':
      console.log(box('⚠ ERROR', [event.message, ...(event.fix ? [`${C.green}${event.fix}${C.reset}`] : [])], C.red))
      break
    case 'thought_chunk':
      break
    case 'final_chunk':
      if (!finalStreamingStarted) {
        finalStreamingStarted = true
        console.log(`\n${C.green}■ REDLINE${C.reset}`)
      }
      process.stdout.write(event.chunk)
      break
    case 'final':
      if (finalStreamingStarted) {
        console.log('\n')
        finalStreamingStarted = false
      } else {
        console.log(`\n${box('■ REDLINE', event.text.split('\n'), C.green)}\n`)
      }
      break
    case 'agent_end':
      finalStreamingStarted = false
      console.log(hr(`${event.steps} steps`, C.dim))
      break
  }
}

// ─── commands ────────────────────────────────────────────────────────────────
const HELP = `${C.bold}REDLINE CLI${C.reset} — commands
  ${C.cyan}/system${C.reset}              environment, charter, tool board
  ${C.cyan}/tools${C.reset}               tool board with availability
  ${C.cyan}/market${C.reset}              marketplace catalog
  ${C.cyan}/install${C.reset} <id> [sys]  register a tool (+ optional system install)
  ${C.cyan}/uninstall${C.reset} <id>      remove a tool
  ${C.cyan}/autodetect${C.reset}          scan the shell for every catalog tool and register what's installed
  ${C.cyan}/knowledge${C.reset} [q]      search the knowledge base (the agent's RAG)
  ${C.cyan}/know${C.reset} add <tool> <title> :: <content>   add an entry
  ${C.cyan}/targets${C.reset}             chartered targets
  ${C.cyan}/target add${C.reset} <h> [-d] / ${C.cyan}/target remove${C.reset} <h>
  ${C.cyan}/engagement${C.reset} <t> [obj]  plan an engagement on a chartered target
  ${C.cyan}/run${C.reset} [id] [agent]    run engagement (heuristic or agent)
  ${C.cyan}/stop${C.reset} [id]           abort a running engagement
  ${C.cyan}/findings${C.reset}            recent findings
  ${C.cyan}/audit${C.reset} [n]           last n audit events
  ${C.cyan}/report${C.reset} [id]         engagement report (markdown)
  ${C.cyan}/mode${C.reset} [name]         guarded | free | unrestricted
  ${C.cyan}/kill${C.reset} [on|off]       kill switch
  ${C.cyan}/endurance${C.reset} [on|off]  unrestricted only: lift time/budget limits
  ${C.cyan}/settings${C.reset}            provider & budgets
  ${C.cyan}/provider${C.reset} <id> [m]   e.g. /provider ollama llama3.1
  ${C.cyan}/clear${C.reset} · ${C.cyan}/help${C.reset} · ${C.cyan}/exit${C.reset}
${C.dim}Anything else is a task for the agent (FREE TERMINAL) or a check request (GUARDED).${C.reset}`

async function cmdSystem() {
  const s = await getSettings()
  const os = detectOS()
  const charter = loadCharter()
  const tools = getRegistry({ resolveAvailability: true })
  console.log(box('SYSTEM', [
    `host      ${os.platform} ${os.release} (${os.arch}) — ${os.hostname}/${os.user}`,
    `wsl       ${os.isWindows ? (os.wsl.available ? `${os.wsl.distros.join(', ')} · preferred ${os.wsl.preferred}${os.wsl.kaliPresent ? ' (KALI)' : ''}` : 'none — PowerShell fallback') : 'n/a (native bash)'}`,
    `exec      ${os.exec.kind} · scratch ${os.exec.scratchRoot}`,
    `mode      ${modeBadge(s.mode)}`,
    `provider  ${s.provider}${s.model ? ` · ${s.model}` : ''}${s.baseUrl ? ` · ${s.baseUrl}` : ''}`,
    `budgets   ${s.budgets.stepsPerTurn} steps · ${s.budgets.turnSeconds}s turns · ${s.budgets.commandSeconds}s commands`,
    `charter   hosts: ${charter.scope.hosts.join(', ') || '—'}`,
    `          nets : ${charter.scope.networks.join(', ')}`,
    `tools     ${tools.filter((t) => t.availability === 'available').length}/${tools.length} ready: ${tools.filter((t) => t.availability === 'available').map((t) => t.name).join(' ')}`,
        `kill sw.  ${s.killSwitch ? `${C.red}ON${C.reset}` : 'off'}`,
        `endurance ${s.mode === 'unrestricted' && s.endurance ? `${C.yellow}ON — no time/budget limits${C.reset}` : 'off'}`,
  ]))
}

async function cmdTools() {
  const tools = getRegistry({ resolveAvailability: true })
  console.log(hr('tool board', C.cyan))
  for (const t of tools) {
    const mark = t.availability === 'available' ? `${C.green}●${C.reset}` : `${C.red}○${C.reset}`
    const caps = Object.keys(t.capabilities).slice(0, 3).join(', ')
    console.log(`  ${mark} ${C.bold}${t.name.padEnd(18)}${C.reset} ${C.dim}[${t.category}]${C.reset} ${truncate(t.tagline, 58)}`)
    console.log(`${C.dim}      tasks: ${caps}${C.reset}`)
  }
}

async function cmdMarket() {
  const tools = await getMarketplace()
  console.log(hr(`marketplace · ${tools.filter((t) => t.installed).length}/${tools.length} registered`, C.cyan))
  for (const t of tools) {
    const mark = t.installed ? `${C.green}▣${C.reset}` : `${C.dim}□${C.reset}`
    const bin = t.availability === 'available' ? `${C.green}bin✓${C.reset}` : t.availability === 'missing' ? `${C.red}bin✗${C.reset}` : `${C.dim}bin?${C.reset}`
    console.log(`  ${mark} ${C.bold}${t.id.padEnd(16)}${C.reset} ${bin} ${truncate(t.tagline, 60)}`)
  }
  console.log(`\n${C.dim}/install <id> to register — the agent learns the tool on its next action.${C.reset}`)
}

async function cmdTargets() {
  const c = loadCharter()
  console.log(box('CHARTER — lab/charter.yaml', [
    `hosts     ${c.scope.hosts.join(', ') || '—'}`,
    `networks  ${c.scope.networks.join(', ')}`,
    `RoE       max ${c.rules_of_engagement.max_concurrent_actions} concurrent · ${c.rules_of_engagement.rate_limit_per_minute}/min · ${c.rules_of_engagement.time_budget_minutes}min budget`,
    `ladder    max rung ${c.exploitation.max_rung}${c.exploitation.replica_host ? '' : ' · rungs 4-5 disabled (no replica)'}`,
  ], C.cyan))
}

async function handleLine(line: string) {
  const text = line.trim()
  if (!text) return
  const [cmd, ...rest] = text.split(/\s+/)

  if (!text.startsWith('/')) {
    // ── chat turn ──
    busy = true
    getRl().pause()
    const spin = new Spinner('thinking…')
    spin.start()
    try {
      await runTurn({ sessionId: SESSION, userText: text, mode: MODE, emit })
    } finally {
      spin.stop()
      busy = false
      getRl().resume()
    }
    return
  }

  switch (cmd) {
    case '/help': case '/?':
      console.log(HELP)
      break
    case '/system': await cmdSystem(); break
    case '/tools': await cmdTools(); break
    case '/market': await cmdMarket(); break
    case '/install': {
      const [id, flag] = rest
      if (!id) { console.log(`${C.dim}usage: /install <tool-id> [sys]${C.reset}`); break }
      const r = await installTool(id, { systemInstall: flag === 'sys' })
      if (r.ok) {
        console.log(`${C.green}▣ ${r.manifest.name} registered — the agent now knows:${C.reset}`)
        console.log(`${C.dim}  purpose: ${truncate(r.manifest.purpose, 100)}${C.reset}`)
        console.log(`${C.dim}  usage:   ${r.manifest.usage[0] ?? ''}${C.reset}`)
        if (r.systemInstallOutput) console.log(`${C.dim}  system:  ${truncate(r.systemInstallOutput, 160)}${C.reset}`)
      } else console.log(`${C.red}${r.error}${C.reset}`)
      break
    }
    case '/uninstall': {
      if (!rest[0]) break
      const r = await uninstallTool(rest[0])
      console.log(r.ok ? `${C.yellow}removed ${rest[0]}${C.reset}` : `${C.red}${r.error}${C.reset}`)
      break
    }
    case '/autodetect': {
      console.log(`${C.dim}scanning the red-team shell for installed tools…${C.reset}`)
      const r = await autodetectTools()
      console.log(hr(`autodetect · ${r.available.length}/${r.scanned} found`, C.cyan))
      for (const t of r.available) console.log(`  ${C.green}●${C.reset} ${C.bold}${t.name.padEnd(16)}${C.reset} ${C.dim}${r.registered.includes(t.id) ? 'newly registered' : 'already on the board'}${C.reset}`)
      const missing = r.missing
      if (missing.length) console.log(`${C.dim}  missing (${missing.length}): ${missing.join(' ')} — install inside the shell, then run /autodetect again${C.reset}`)
      console.log(r.registered.length ? `${C.green}✓ ${r.registered.length} tool(s) added to the agent's board${C.reset}` : `${C.dim}board already up to date${C.reset}`)
      break
    }
    case '/knowledge':
    case '/know': {
      const sub = rest[0]
      if (sub === 'add') {
        // /knowledge add <tool> <title> :: <content>
        const joined = rest.slice(1).join(' ')
        const [head, content] = joined.split('::')
        const headParts = (head ?? '').trim().split(/\s+/)
        if (!content?.trim() || headParts.length < 2) {
          console.log(`${C.dim}usage: /knowledge add <tool> <kind> <title> :: <content>${C.reset}`)
          console.log(`${C.dim}  kind: tool_usage | command_syntax | mistake | planning${C.reset}`)
          break
        }
        const [tool, kind, ...titleWords] = headParts
        const validKinds = ['tool_usage', 'command_syntax', 'mistake', 'planning']
        if (!validKinds.includes(kind)) {
          console.log(`${C.red}kind "${kind}" must be one of: ${validKinds.join(', ')}${C.reset}`)
          break
        }
        const entry = await createKnowledge({ kind: kind as any, tool, title: titleWords.join(' '), content: content.trim(), tags: [tool] })
        console.log(`${C.green}✓ entry #${entry.id} added — the agent retrieves it from the next turn${C.reset}`)
        break
      }
      if (sub === 'del') {
        const id = Number(rest[1])
        if (!Number.isFinite(id)) { console.log(`${C.dim}usage: /knowledge del <id>${C.reset}`); break }
        const ok = await deleteKnowledge(id)
        console.log(ok ? `${C.yellow}deleted entry #${id}${C.reset}` : `${C.red}entry #${id} not found${C.reset}`)
        break
      }
      if (sub === 'docs') {
        const tools = rest.slice(1)
        console.log(`${C.dim}fetching tldr command docs${tools.length ? ` for: ${tools.join(' ')}` : ' for every installed tool'}…${C.reset}`)
        const r = await ingestOnlineDocs(tools.length ? tools : undefined)
        console.log(`${C.green}✓ ingested: ${r.ingested.join(', ') || '(none)'}${C.reset}`)
        if (r.missing.length) console.log(`${C.dim}  no tldr page: ${r.missing.join(', ')}${C.reset}`)
        if (r.failed.length) console.log(`${C.red}  failed: ${r.failed.map((f) => `${f.tool} (${f.error})`).join(', ')}${C.reset}`)
        break
      }
      if (sub === 'reindex') {
        console.log(`${C.dim}embedding knowledge entries via the dedicated embedder (:8081)…${C.reset}`)
        const r = await reindexKnowledge(rest.includes('--force') || rest.includes('-f'))
        if (r.skipped) console.log(`${C.yellow}vector search disabled — set the embedding server URL in Settings / /settings${C.reset}`)
        else console.log(`${C.green}✓ embedded ${r.indexed} entries (${r.total} total) — semantic search active${C.reset}`)
        break
      }
      if (sub === 'import') {
        const path = rest[1]
        if (!path) { console.log(`${C.dim}usage: /knowledge import <file.pdf|docx|csv|txt|md>${C.reset}`); break }
        let buf: Buffer | null = null
        try { buf = readFileSync(path) } catch { buf = null }
        if (!buf) { console.log(`${C.red}cannot read ${path}${C.reset}`); break }
        console.log(`${C.dim}extracting text and converting with the AI (${(buf.length / 1024).toFixed(0)}KB)…${C.reset}`)
        const r = await importDocument(path.split(/[\\/]/).pop() ?? path, buf)
        if (!r.ok) { console.log(`${C.red}${r.error}${r.detail ? ` — ${r.detail}` : ''}${C.reset}`); break }
        console.log(`${C.green}✓ imported ${r.entries.length} entries:${C.reset}`)
        for (const e of r.entries) console.log(`  ${C.green}●${C.reset} [${e.kind}${e.tool ? `:${e.tool}` : ''}] ${truncate(e.title, 60)}`)
        break
      }
      const query = rest.join(' ')
      const results = query ? await searchKnowledge(query, { limit: 10 }) : (await listKnowledge()).map((entry) => ({ entry, score: 0 }))
      console.log(hr(`knowledge base · ${results.length}${query ? ` matches for "${query}"` : ' entries'}`, C.cyan))
      for (const { entry, score } of results) {
        const kindTag = `${C.dim}[${entry.kind}${entry.tool ? `:${entry.tool}` : ''}${score ? ` · ${score}` : ''}]${C.reset}`
        console.log(`  ${C.cyan}#${entry.id}${C.reset} ${kindTag} ${C.bold}${truncate(entry.title, 52)}${C.reset}`)
        console.log(`${C.dim}      ${truncate(entry.content, 90)}${C.reset}`)
      }
      break
    }
    case '/targets': await cmdTargets(); break
    case '/target': {
      const sub = rest[0]
      if (sub === 'add') {
        const host = rest[1]
        const detect = rest.includes('-d') || rest.includes('--detect')
        if (!host) { console.log(`${C.dim}usage: /target add <host> [--detect]${C.reset}`); break }
        const r = await addHost(host, { detect })
        if (!r.ok) { console.log(`${C.red}${r.error}${C.reset}`); break }
        const ips = (r as any).ips ?? []
        console.log(`${C.green}✓ chartered ${host}${r.added ? '' : ' (already there)'}${ips.length ? ` → ${ips.join(', ')}` : ' (no DNS — hosts_map empty)'}${C.reset}`)
        if ((r as any).findings?.length) console.log(`${C.dim}  detect: ${(r as any).findings.join(' · ')}${C.reset}`)
      } else if (sub === 'remove') {
        const r = await removeHost(rest[1] ?? '')
        console.log(r.ok ? `${C.yellow}✓ removed${C.reset}` : `${C.red}${(r as any).error}${C.reset}`)
      } else await cmdTargets()
      break
    }
    case '/engagement': {
      if (rest[0] === 'list' || !rest[0]) {
        const rows = await db.engagement.findMany({ orderBy: { id: 'desc' }, take: 10 })
        for (const e of rows) console.log(`  ${C.cyan}${String(e.id).padStart(3)}${C.reset} ${e.eid.padEnd(16)} ${e.target.padEnd(22)} ${e.status}`)
        break
      }
      const target = rest[0]
      const objective = rest.slice(1).join(' ') || 'full attack-surface assessment, low footprint'
      const r = await createEngagement({ target, objective, profile: 'balanced', domains: [], mode: MODE })
      if (!r.ok) { console.log(`${C.red}✗ ${r.error}${C.reset}\n${C.green}  fix: ${r.fix}${C.reset}`); break }
      console.log(box(`PLANNED · ${r.engagement.eid}`, [
        `target    ${target}`,
        `objective ${objective}`,
        `tasks     ${r.engagement.id} → /run ${r.engagement.id}  (or /run ${r.engagement.id} agent)`,
        `${C.dim}ladder-gated · honeypot heuristics on · footprint accounting on${C.reset}`,
      ], C.green))
      break
    }
    case '/run': {
      const id = Number(rest[0]) || undefined
      const runner = rest.includes('agent') ? 'agent' : 'heuristic'
      let eid = id
      if (!eid) {
        const last = await db.engagement.findFirst({ orderBy: { id: 'desc' } })
        eid = last?.id
      }
      if (!eid) { console.log(`${C.dim}no engagement — /engagement <target> first${C.reset}`); break }
      busy = true
      getRl().pause()
      console.log(hr(`engagement run · ${runner}`, C.green))
      try {
        await runEngagement(eid, { runner, emit })
      } finally {
        busy = false
        getRl().resume()
      }
      const rep = await generateReport(eid)
      console.log(`\n${box('REPORT READY', [`${C.dim}full report: /report ${eid}${C.reset}`], C.green)}`)
      void rep
      break
    }
    case '/stop': {
      const id = Number(rest[0]) || undefined
      const last = id ?? (await db.engagement.findFirst({ orderBy: { id: 'desc' } }))?.id
      if (last) { await stopEngagement(last); console.log(`${C.yellow}■ engagement ${last} aborting${C.reset}`) }
      break
    }
    case '/findings': {
      const rows = await db.finding.findMany({ orderBy: { id: 'desc' }, take: 20 })
      if (!rows.length) { console.log(`${C.dim}no findings yet${C.reset}`); break }
      for (const f of rows) {
        const sev = { critical: C.red, high: C.magenta, medium: C.amber, low: C.cyan, info: C.dim }[f.severity as 'info'] ?? C.dim
        console.log(`  ${sev}${f.severity.padEnd(8)}${C.reset} ${truncate(f.title, 80)}`)
      }
      break
    }
    case '/audit': {
      const n = Number(rest[0]) || 15
      const rows = await listAudit({ limit: n })
      for (const a of rows.reverse()) {
        const tone = a.verdict === 'allowed' ? C.green : ['refused', 'blocked'].includes(a.verdict ?? '') ? C.red : C.dim
        let d: any = {}
        try { d = JSON.parse(a.detail) } catch { /* noop */ }
        console.log(`  ${C.dim}${new Date(a.ts).toLocaleTimeString()}${C.reset} ${tone}${a.kind.padEnd(22)}${C.reset} ${truncate(String(d.command ?? d.reason ?? d.host ?? d.tool ?? d.action ?? ''), 66)}`)
      }
      break
    }
    case '/report': {
      const id = Number(rest[0]) || (await db.engagement.findFirst({ orderBy: { id: 'desc' } }))?.id
      if (!id) { console.log(`${C.dim}no engagement yet${C.reset}`); break }
      console.log(await generateReport(id))
      break
    }
    case '/mode': {
      const target = rest[0] as Mode | undefined
      if (!target) { console.log(`current: ${modeBadge(MODE)}${C.dim}  (guarded | free | unrestricted)${C.reset}`); break }
      if (!['guarded', 'free', 'unrestricted'].includes(target)) { console.log(`${C.red}unknown mode${C.reset}`); break }
      if (target === 'unrestricted') {
        console.log(box('⚠ UNRESTRICTED — EXPLICIT OVERRIDE', [
          'OFF: charter egress check (any host) · approval cards (nothing waits)',
          'ON : destructive block · rate limits · budgets · kill switch · audits · engagement gate',
          'Persists across restarts until you switch back.',
        ], C.red))
        const ans = await question(`${C.red}type ${C.bold}OVERRIDE${C.reset}${C.red} to confirm:${C.reset} `)
        if (ans !== 'OVERRIDE') { console.log('aborted — staying safe'); break }
      }
      await setSettings({ mode: target })
      MODE = target
      flushSessionGuards()
      await audit(target === 'unrestricted' ? 'unrestricted_enabled' : 'mode_changed', { to: target, by: 'cli' }, { actor: 'operator', mode: target, verdict: 'info' })
      console.log(`mode → ${modeBadge(MODE)}`)
      break
    }
    case '/kill': {
      const on = rest[0] ? rest[0] === 'on' : !(await getSettings()).killSwitch
      await setSettings({ killSwitch: on })
      await audit('kill_switch', { enabled: on, by: 'cli' }, { actor: 'operator', verdict: on ? 'blocked' : 'allowed' })
      console.log(on ? `${C.red}■ KILL SWITCH ARMED — every action refused until /kill off${C.reset}` : `${C.green}kill switch cleared${C.reset}`)
      break
    }
    case '/endurance': {
      const s0 = await getSettings()
      if (s0.mode !== 'unrestricted') { console.log(`${C.red}ENDURANCE is only available inside UNRESTRICTED mode (/mode unrestricted)${C.reset}`); break }
      const on = rest[0] ? rest[0] === 'on' : !s0.endurance
      await setSettings({ endurance: on })
      await audit('endurance_toggled', { endurance: on, by: 'cli' }, { actor: 'operator', mode: 'unrestricted', verdict: 'info' })
      console.log(on
        ? `${C.yellow}▲ ENDURANCE ON — no time/budget limits (1000 steps · 24h turns · 1h commands · no rate cap). Kill switch, destructive block and audits remain.${C.reset}`
        : `${C.green}endurance off — budgets restored${C.reset}`)
      break
    }
    case '/settings': {
      const s = await getSettings()
      console.log(box('SETTINGS', [
        `provider  ${s.provider}`,
        `model     ${s.model || '(provider default)'}`,
        `baseUrl   ${s.baseUrl || '(provider default)'}`,
        `apiKey    ${s.apiKey ? '•••• set' : '—'}`,
        `budgets   ${s.budgets.stepsPerTurn} steps · ${s.budgets.turnSeconds}s turns · ${s.budgets.commandSeconds}s commands`,
        `${C.dim}/provider <zai|ollama|lmstudio|llamacpp|openai-compat|openai|anthropic> [model] [baseUrl]${C.reset}`,
      ]))
      break
    }
    case '/provider': {
      const [id, model, baseUrl] = rest
      if (!id) { console.log(`${C.dim}usage: /provider ollama llama3.1 http://localhost:11434/v1${C.reset}`); break }
      await setSettings({ provider: id as any, ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}) })
      await audit('settings_changed', { provider: id, model, baseUrl }, { actor: 'operator', verdict: 'info' })
      console.log(`${C.green}✓ provider → ${id}${model ? ` · ${model}` : ''}${baseUrl ? ` · ${baseUrl}` : ''}${C.reset}`)
      break
    }
    case '/clear':
      console.clear()
      break
    case '/exit': case '/quit':
      rl?.close()
      process.exit(0)
    default:
      console.log(`${C.dim}unknown command — /help${C.reset}`)
  }
}

// ─── boot ────────────────────────────────────────────────────────────────────
async function main() {
  await warmRegistry()
  const s = await getSettings()
  MODE = s.mode
  const os = detectOS()
  const charter = loadCharter()

  console.log(`\n${banner('REDLINE')}`)
  console.log(`${C.dim}  ai red team operations · charter-scoped · every action gated, streamed & audited${C.reset}\n`)
  console.log(box('ENVIRONMENT', [
    `mode      ${modeBadge(MODE)}${s.killSwitch ? ` ${C.red}· KILL SWITCH ON${C.reset}` : ''}`,
    `host      ${os.platform} (${os.arch})${os.isWindows ? ` · WSL: ${os.wsl.available ? os.wsl.distros.join(',') : 'none'}` : ''}`,
    `exec      ${os.exec.kind} — ${os.exec.note}`,
    `brain     ${s.provider}${s.model ? ` · ${s.model}` : ''}`,
    `charter   ${charter.scope.hosts.join(', ') || '—'}`,
    `${C.dim}/help for commands · anything else goes to the agent${C.reset}`,
  ]))
  console.log()

  // non-interactive modes
  const evalIdx = process.argv.indexOf('--eval')
  const cmdIdx = process.argv.indexOf('--cmd')
  if (evalIdx > -1 && process.argv[evalIdx + 1]) {
    await handleLine(process.argv[evalIdx + 1])
    await db.$disconnect().catch(() => {})
    process.exit(0)
  }
  if (cmdIdx > -1 && process.argv[cmdIdx + 1]) {
    await handleLine(process.argv[cmdIdx + 1])
    await db.$disconnect().catch(() => {})
    process.exit(0)
  }

  const iface = getRl()
  iface.prompt()
  iface.on('line', async (line) => {
    if (busy) return
    try {
      await handleLine(line)
    } catch (e: any) {
      console.error(`${C.red}error: ${e?.message ?? e}${C.reset}`)
    }
    if (!busy) iface.prompt()
  })
  iface.on('SIGINT', () => {
    if (busy) { console.log(`\n${C.amber}(task running — /kill arms the global kill switch; Ctrl-C again to force)${C.reset}`); return }
    console.log(`\n${C.dim}▮ goodbye${C.reset}`)
    process.exit(0)
  })
  iface.on('close', () => process.exit(0))
}

void main()
