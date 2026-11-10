// ─────────────────────────────────────────────────────────────────────────────
// Honeypot detection — find the pots by their BEHAVIOR, flag them, and go
// around them. Heuristics run automatically on every scan-ish output; the
// agent adds its own judgment via flag_honeypot. Both land in the report.
// ─────────────────────────────────────────────────────────────────────────────
import type { HoneypotAnalysis, HoneypotSignal } from '../types'

const HONEYPOT_BANNER_SIGS = [
  /cowrie/i, /dionaea/i, /kippo/i, /glastopf/i, /honeyport/i, /honeypot/i, /honeytrap/i, /mnemosyne/i,
  /welcome to (ubuntu|debian|linux|metasploitable)/i, /root@.*:~#\s*$/im,
]

const COMMON_PORTS = [21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 443, 445, 993, 995, 1433, 1521, 2049, 3306, 3389, 5432, 5900, 5985, 6379, 8080, 8443, 9200, 11211, 27017]

export interface HoneypotHeuristicInput {
  openPorts?: number[]
  banners?: string[]
  services?: string[]
  note?: string
}

export function analyzeSignals(target: string, input: HoneypotHeuristicInput, threshold = 60): HoneypotAnalysis {
  const signals: HoneypotSignal[] = []
  const ports = input.openPorts ?? []
  const banners = input.banners ?? []
  const services = input.services ?? []

  if (ports.length >= 100) {
    signals.push({ name: 'absurd open-port count', weight: 25, detail: `${ports.length} open ports — real hosts rarely expose this much` })
  } else if (ports.length >= 20) {
    signals.push({ name: 'high open-port count', weight: 15, detail: `${ports.length} open ports` })
  }

  const commonOpen = COMMON_PORTS.filter((p) => ports.includes(p))
  if (commonOpen.length >= 15) {
    signals.push({ name: 'full common-port surface', weight: 20, detail: `${commonOpen.length}/${COMMON_PORTS.length} common service ports all open (${commonOpen.join(',')})` })
  } else if (commonOpen.length >= 10) {
    signals.push({ name: 'broad common-port surface', weight: 10, detail: `${commonOpen.length} common ports open` })
  }

  for (const re of HONEYPOT_BANNER_SIGS) {
    const hit = banners.find((b) => re.test(b))
    if (hit) signals.push({ name: 'honeypot banner signature', weight: 30, detail: hit.slice(0, 120) })
  }

  const svc = services.map((s) => s.toLowerCase()).join(' ')
  const contradictions: string[] = []
  if (/(mysql|3306)/.test(svc) && /(redis|6379)/.test(svc) && /(elasticsearch|kibana|9200)/.test(svc)) contradictions.push('mysql+redis+elastic on one host')
  if (/(telnet|23)/.test(svc) && /(https|443)/.test(svc)) contradictions.push('telnet alongside https')
  if (/(ftp|21)/.test(svc) && /(rdp|3389)/.test(svc) && /(mongodb|27017)/.test(svc)) contradictions.push('ftp+rdp+mongodb mix')
  if (contradictions.length) {
    signals.push({ name: 'contradictory service mix', weight: 15, detail: contradictions.join('; ') })
  }

  // identical banners repeated = one fake banner generator
  const counts = new Map<string, number>()
  for (const b of banners) counts.set(b, (counts.get(b) ?? 0) + 1)
  const dup = Array.from(counts.entries()).find(([, n]) => n >= 5)
  if (dup) signals.push({ name: 'identical repeated banners', weight: 10, detail: `"${dup[0].slice(0, 80)}" × ${dup[1]}` })

  if (input.note) signals.push({ name: 'context note', weight: 5, detail: input.note })

  const score = Math.min(100, signals.reduce((s, x) => s + x.weight, 0))
  const verdict: HoneypotAnalysis['verdict'] = score >= threshold ? 'likely_honeypot' : score >= Math.ceil(threshold / 2) ? 'possible' : 'clean'
  return {
    target,
    score,
    threshold,
    verdict,
    signals,
    strategy: verdict === 'likely_honeypot'
      ? 'ROUTE AROUND: deprioritize this host, do NOT feed it credentials or exploits (that is exactly what it wants), corroborate findings passively, flag it in the report, and continue with adjacent infrastructure.'
      : verdict === 'possible'
        ? 'Treat with suspicion: prefer passive corroboration before any active technique against it.'
        : 'No strong honeypot signals.',
  }
}

/** Parse scan output text (nmap/masscan/httpx style) and run the heuristics.
 *  Returns null when the output carries no port/banner signal at all. */
export function analyzeText(target: string, output: string, threshold = 60): HoneypotAnalysis | null {
  const openPorts: number[] = []
  const banners: string[] = []
  const services: string[] = []

  // nmap-ish: "22/tcp  open  ssh  OpenSSH 8.9"
  const nmapRe = /^(\d{1,5})\/(tcp|udp)\s+open\s+(\S+)(?:\s+(.*))?$/gm
  let m: RegExpExecArray | null
  while ((m = nmapRe.exec(output))) {
    openPorts.push(Number(m[1]))
    services.push(`${m[3]} ${m[1]}`)
    if (m[4]) banners.push(m[4].trim())
  }
  // masscan-ish: "Discovered open port 22/tcp on 1.2.3.4"
  const massRe = /discovered open port (\d{1,5})\//gi
  while ((m = massRe.exec(output))) openPorts.push(Number(m[1]))

  // banner-ish lines
  for (const line of output.split('\n')) {
    const t = line.trim()
    if (/^(220|230|250|550)\s/.test(t) || /server:?\s+\S+/i.test(t) || /x-powered-by:?\s+\S+/i.test(t)) banners.push(t.slice(0, 160))
  }
  const uniquePorts = Array.from(new Set(openPorts))
  if (uniquePorts.length === 0 && banners.length === 0) return null
  return analyzeSignals(target, { openPorts: uniquePorts, banners: Array.from(new Set(banners)).slice(0, 40), services: Array.from(new Set(services)).slice(0, 40) }, threshold)
}
