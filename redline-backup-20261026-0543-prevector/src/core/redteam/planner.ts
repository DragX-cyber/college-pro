// Planner — turns an operator's objective into a kill-chain plan with
// parallel-friendly task groups, domain coverage, and profile-driven
// footprint policy. This is the "70-90% of the red team's work" scaffold the
// agent (or the deterministic runner) executes.
import type { EngagementPlan, Phase, PlanTask } from '../types'
import { TASK_TEMPLATES } from './killchain'
import { profilePolicy } from './footprint'

export interface PlanInput {
  target: string
  objective: string
  profile: 'stealth' | 'balanced' | 'fast'
  domains: string[]
}

const PHASE_ORDER: Phase[] = ['recon', 'enumeration', 'vuln_analysis', 'exploitation', 'post_exploit', 'reporting']

export function planEngagement(input: PlanInput): EngagementPlan {
  const policy = profilePolicy(input.profile)
  const domains = input.domains.length ? input.domains : ['network', 'web', 'dns', 'vuln']

  // Templates relevant to chosen domains; the core chain (network, web, dns,
  // vuln, exploit ladder) is always in — gates are enforced at run time.
  const activeDomains = new Set([...domains, 'network', 'web', 'dns', 'vuln', 'exploit'])
  const templates = TASK_TEMPLATES.filter((t) => activeDomains.has(t.domain))

  // Parallel groups: independent tasks share a group; groups run in order.
  const groupOf: Record<string, number> = {
    'recon.passive.dns': 0, 'recon.passive.whois': 0, 'recon.reach': 0,
    'enum.ports.fast': 1,
    'enum.ports.followup': 2, 'enum.web.tech': 2, 'enum.web.waf': 2,
    'enum.dirs': 3, 'enum.dns.subs': 3, 'enum.tls': 3, 'enum.smb': 3, 'enum.snmp': 3,
    'vuln.nuclei': 4, 'vuln.tls.deep': 4, 'vuln.exploitdb': 4,
    'exploit.rung1.safe': 5, 'exploit.rung2.cred': 5, 'exploit.rung3.poc': 5,
    'post.evidence': 6,
  }

  const tasks: PlanTask[] = templates.map((t) => ({
    title: t.title,
    phase: t.phase,
    domain: t.domain,
    parallelGroup: groupOf[t.id] ?? 0,
    toolHint: t.toolTask,
    stealthNote: input.profile === 'stealth' && t.commands[0]?.stealthTemplate
      ? 'stealth profile: use the capped-rate variant'
      : undefined,
  }))

  const phases = PHASE_ORDER.map((phase) => {
    const phaseTasks = tasks.filter((t) => t.phase === phase)
    const groupsMap = new Map<number, PlanTask[]>()
    for (const t of phaseTasks) {
      const arr = groupsMap.get(t.parallelGroup) ?? []
      arr.push(t)
      groupsMap.set(t.parallelGroup, arr)
    }
    return {
      phase,
      groups: Array.from(groupsMap.entries()).sort((a, b) => a[0] - b[0]).map(([group, ts]) => ({ group, tasks: ts })),
    }
  }).filter((p) => p.groups.length > 0)

  const notes = [
    `Tasks inside the same group are independent — raise charter max_concurrent_actions above 1 to run them in parallel (currently the runner executes groups sequentially in group order).`,
    `Ladder gates: exploitation tasks carry rungs; rungs above the charter's max_rung are skipped automatically, and rungs 4-5 need a replica_host.`,
    `Tool choice per task comes from the live strategy board (speed vs coverage vs stealth weighting) — installing tools from the Marketplace immediately upgrades the plan's options.`,
  ]

  return {
    target: input.target,
    objective: input.objective,
    profile: input.profile,
    phases,
    footprintPolicy: policy.guidance,
    notes,
  }
}

/** Flatten a plan for DB persistence. */
export function planTasksFlat(plan: EngagementPlan): PlanTask[] {
  return plan.phases.flatMap((p) => p.groups.flatMap((g) => g.tasks))
}
