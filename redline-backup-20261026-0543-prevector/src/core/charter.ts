// ─────────────────────────────────────────────────────────────────────────────
// Charter — the operator's written authorization (lab/charter.yaml).
//
// Two design rules from the scope document:
//   1. It is loaded fresh for every action. It is never held in memory where
//      a stale copy could diverge.
//   2. The AI can never edit it. Adding targets is an operator action only
//      (Targets page, CLI /targets, or `python charter_add.py add <host>`).
//
// resolveTarget() is the single function that answers "may I touch this?".
// Its check is TWO-SIDED — both halves must pass:
//   1. Name side: hostname (scheme/port/path stripped) in scope.hosts OR its
//      resolved IP inside scope.networks.
//   2. IP side: the host must resolve to an IP that lives inside a chartered
//      network. Literal IP → network membership only. A resolution failure is
//      a refusal, never a pass-through.
// This closes the classic DNS-rebinding hole in both directions.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { promises as dns } from 'dns'
import net from 'net'
import ipaddr from 'ipaddr.js'
import { load as yamlLoad, dump as yamlDump } from 'js-yaml'
import { CHARTER_PATH, LAB_DIR } from './paths'
import { audit } from './audit'
import type { Charter, ResolveResult } from './types'

export const DEFAULT_CHARTER: Charter = {
  engagement_id: null,
  scope: {
    hosts: ['localhost'],
    networks: ['127.0.0.1/32', '::1/128'],
    hosts_map: { localhost: ['127.0.0.1'] },
    base_urls: {},
  },
  rules_of_engagement: {
    max_concurrent_actions: 1,
    rate_limit_per_minute: 30,
    destructive_actions: 'forbidden',
    exploit_demo: null,
    time_budget_minutes: 90,
  },
  exploitation: {
    ladder_enabled: true,
    max_rung: 3,
    replica_host: null,
    chain_budget: { max_depth: 5, max_minutes: 40, max_attempts_per_step: 2 },
  },
  deception: { enabled: true, honeypot_threshold: 60 },
  autonomy: { mode: 'advisory' },
}

function normalize(parsed: any): Charter {
  const d = DEFAULT_CHARTER
  if (!parsed || typeof parsed !== 'object') return structuredClone(d)
  return {
    engagement_id: parsed.engagement_id ?? null,
    scope: {
      hosts: Array.isArray(parsed?.scope?.hosts) ? parsed.scope.hosts.map(String) : d.scope.hosts,
      networks: Array.isArray(parsed?.scope?.networks) ? parsed.scope.networks.map(String) : d.scope.networks,
      hosts_map: parsed?.scope?.hosts_map && typeof parsed.scope.hosts_map === 'object' ? parsed.scope.hosts_map : d.scope.hosts_map,
      base_urls: parsed?.scope?.base_urls && typeof parsed.scope.base_urls === 'object' ? parsed.scope.base_urls : {},
    },
    rules_of_engagement: { ...d.rules_of_engagement, ...(parsed?.rules_of_engagement ?? {}) },
    exploitation: { ...d.exploitation, ...(parsed?.exploitation ?? {}) },
    deception: { ...d.deception, ...(parsed?.deception ?? {}) },
    autonomy: { mode: parsed?.autonomy?.mode ?? d.autonomy.mode },
  }
}

/** Loaded fresh for every action — never cached. */
export function loadCharter(): Charter {
  try {
    const raw = readFileSync(CHARTER_PATH, 'utf8')
    return normalize(yamlLoad(raw))
  } catch {
    if (!existsSync(CHARTER_PATH)) {
      try {
        saveCharter(DEFAULT_CHARTER)
      } catch { /* read-only fs: fall back to defaults in memory */ }
    }
    return structuredClone(DEFAULT_CHARTER)
  }
}

export function saveCharter(c: Charter) {
  mkdirSync(LAB_DIR, { recursive: true })
  writeFileSync(CHARTER_PATH, yamlDump(c, { lineWidth: 120 }), 'utf8')
}

// ─── host normalization ───────────────────────────────────────────────────────

/** Strip scheme, userinfo, port, path, brackets. Returns null for garbage. */
export function normalizeHost(input: string): string | null {
  let t = (input ?? '').trim()
  if (!t) return null
  // URL form (http://host:port/path, ftp://..., etc.)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    try {
      const u = new URL(t)
      t = u.hostname
    } catch {
      return null
    }
  }
  // scheme:port form some tools use (host:8080)
  t = t.replace(/^[a-z][a-z0-9+.-]*:/i, (m) => (/^(https?|ftp|ssh|telnet|smtp|dns):?$/i.test(m.replace(':', '')) ? m : ''))
  t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  t = t.split('/')[0].split('?')[0].split('#')[0]
  t = t.replace(/^[^@]*@/, '') // userinfo
  t = t.replace(/^\[|\]$/g, '') // ipv6 brackets
  t = t.replace(/:\d{1,5}$/, '') // port
  t = t.trim().toLowerCase()
  if (!t) return null
  if (ipaddr.isValid(t)) return t // literal IP (v4 or v6)
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(t)) return t
  return null
}

export function isLiteralIP(s: string): boolean {
  try {
    return ipaddr.isValid(s.trim())
  } catch {
    return false
  }
}

/** IP inside any chartered network (IPv4-mapped IPv6 normalized). */
export function ipInNetworks(ip: string, networks: string[]): boolean {
  try {
    const addr = ipaddr.process(ip.trim())
    for (const net of networks) {
      try {
        if (addr.match(ipaddr.parseCIDR(net.trim()))) return true
      } catch { /* malformed network entry — skip, never widen */ }
    }
  } catch { /* unparsable IP — refuse by returning false */ }
  return false
}

async function resolveName(charter: Charter, name: string): Promise<string[]> {
  // Resolution order: literal IP → static hosts_map → real DNS
  if (charter.scope.hosts_map[name]?.length) return charter.scope.hosts_map[name]
  try {
    const res = await dns.lookup(name, { all: true })
    return res.map((r) => r.address)
  } catch {
    return []
  }
}

/**
 * The single function that answers "may I touch this?"
 * Both halves must pass — see file header.
 */
export async function resolveTarget(charter: Charter, target: string): Promise<ResolveResult> {
  const host = normalizeHost(target)
  if (!host) {
    return { ok: false, reason: `"${target}" is not a valid host, IP or URL`, fix: 'Pass a hostname, literal IP, or URL' }
  }
  const nets = charter.scope.networks
  const fix = `python charter_add.py add ${host} --detect`

  // Literal IP — only needs network membership.
  if (isLiteralIP(host)) {
    if (ipInNetworks(host, nets)) return { ok: true, ip: host, name: host }
    return {
      ok: false,
      reason: `IP ${host} is not inside any chartered network`,
      fix,
      ip: host,
    }
  }

  const ips = await resolveName(charter, host)
  if (ips.length === 0) {
    return {
      ok: false,
      reason: `could not resolve "${host}" (no static hosts_map entry, DNS failed) — a resolution failure is a refusal, never a pass-through`,
      fix: `Add it with its IP: python charter_add.py add ${host} --detect`,
      name: host,
    }
  }

  const inNets = ips.filter((ip) => ipInNetworks(ip, nets))
  const chartered = charter.scope.hosts.includes(host)

  if (chartered) {
    // Name side passed (explicitly authorized) — but the IP side must hold too.
    if (inNets.length === ips.length) {
      return { ok: true, ip: inNets[0], name: host }
    }
    return {
      ok: false,
      reason: `chartered host "${host}" resolves outside chartered networks (${ips.join(', ')}) — possible DNS drift; refusing for safety`,
      fix: 'Verify the host really points where you expect, then update hosts_map in lab/charter.yaml',
      ip: ips[0],
      name: host,
    }
  }

  // Unchartered name that happens to resolve to a chartered IP is allowed —
  // the operator authorized that IP address.
  if (inNets.length > 0) {
    return { ok: true, ip: inNets[0], name: host }
  }
  return {
    ok: false,
    reason: `host "${host}" is not chartered (resolves to ${ips.join(', ')}, outside chartered networks)`,
    fix,
    ip: ips[0],
    name: host,
  }
}

// ─── operator actions (never exposed to the agent) ───────────────────────────

export async function addHost(host: string, opts: { detect?: boolean } = {}) {
  const h = normalizeHost(host)
  if (!h) return { ok: false, error: 'not a valid host' }
  const charter = loadCharter()
  if (charter.scope.hosts.includes(h)) {
    return { ok: true, charter, added: false, note: `${h} is already chartered`, findings: [] as string[] }
  }

  // Resolve first so the operator sees drift immediately.
  let ips: string[] = []
  if (isLiteralIP(h)) ips = [h]
  else {
    try {
      ips = (await dns.lookup(h, { all: true })).map((r) => r.address)
    } catch { ips = [] }
  }

  charter.scope.hosts.push(h)
  if (ips.length) {
    charter.scope.hosts_map[h] = ips
    for (const ip of ips) {
      const cidr = ip.includes(':') ? `${ip}/128` : `${ip}/32`
      if (!charter.scope.networks.includes(cidr)) charter.scope.networks.push(cidr)
    }
  }
  saveCharter(charter)
  await audit('charter_changed', { action: 'add_host', host: h, ips, detected: !!opts.detect }, { actor: 'operator', verdict: 'allowed' })

  const findings: string[] = []
  if (opts.detect && ips.length) {
    for (const port of [22, 80, 443, 8080, 3306]) {
      const open = await probeTcp(ips[0], port, 900)
      if (open) findings.push(`tcp/${port} open on ${ips[0]}`)
    }
    if (findings.length) {
      await audit('charter_changed', { action: 'detect', host: h, findings }, { actor: 'operator', verdict: 'allowed' })
    }
  }
  return { ok: true, charter, added: true, ips, findings }
}

export async function removeHost(host: string) {
  const charter = loadCharter()
  const h = normalizeHost(host)
  if (!h || !charter.scope.hosts.includes(h)) return { ok: false, error: 'host not in charter' }
  charter.scope.hosts = charter.scope.hosts.filter((x) => x !== h)
  delete charter.scope.hosts_map[h]
  saveCharter(charter)
  await audit('charter_changed', { action: 'remove_host', host: h }, { actor: 'operator', verdict: 'allowed' })
  return { ok: true, charter }
}

export function probeTcp(ip: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    const done = (v: boolean) => { try { sock.destroy() } catch {} ; resolve(v) }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    try { sock.connect(port, ip) } catch { done(false) }
  })
}

export function charterSummary() {
  const c = loadCharter()
  return {
    engagement_id: c.engagement_id,
    hosts: c.scope.hosts,
    networks: c.scope.networks,
    hosts_map: c.scope.hosts_map,
    base_urls: c.scope.base_urls,
    rules: c.rules_of_engagement,
    exploitation: c.exploitation,
    deception: c.deception,
    autonomy: c.autonomy,
  }
}
