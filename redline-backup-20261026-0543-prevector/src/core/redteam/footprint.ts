// ─────────────────────────────────────────────────────────────────────────────
// Footprint discipline — from recon to exploitation the agent must use the
// least-visible method that answers the question. estimateFootprint() scores
// every planned command 1-5; profiles bound what the planner will accept.
// ─────────────────────────────────────────────────────────────────────────────
import type { Phase } from '../types'

const PASSIVE = /\b(whois|dig|host|nslookup|sublist3r|theharvester|amass\s+enum\s+-passive|searchsploit|crt\.sh)\b/i
const TARGETED = /\b(ping|curl|whatweb|wafw00f|httpx)\b/i
const TOPPORTS = /(top-ports|rate[= ]\d{1,3}($|\s))|rustscan|-sV\s+-p|--max-rate\s+\d{1,3}\b/i
const FULLRANGE = /(-p-|-p1-65535|-p 1-65535|--rate=\d{4,}|-A\b|--script-all)/i
const LOUD = /\b(nikto|hydra|sqlmap|msfconsole|metasploit|netexec|crackmapexec|gobuster|ffuf|dirb|dirsearch|unicornscan|nuclei)\b/i

/** 1 (invisible) … 5 (extremely loud) */
export function estimateFootprint(command: string): number {
  const c = command.trim()
  if (PASSIVE.test(c)) return 1
  if (FULLRANGE.test(c)) return 5
  if (LOUD.test(c)) return 4
  if (TOPPORTS.test(c)) return 3
  if (TARGETED.test(c)) return 2
  return 3
}

export const FOOTPRINT_LABEL = ['passive', 'whisper', 'targeted', 'active', 'loud']

export interface ProfilePolicy {
  profile: 'stealth' | 'balanced' | 'fast'
  maxFootprint: Record<Phase, number>
  guidance: string
}

export function profilePolicy(profile: 'stealth' | 'balanced' | 'fast'): ProfilePolicy {
  if (profile === 'stealth') {
    return {
      profile,
      maxFootprint: { recon: 1, enumeration: 3, vuln_analysis: 3, exploitation: 4, post_exploit: 2, reporting: 1 },
      guidance: 'STEALTH: passive sources first (whois, dig, sublist3r, cert transparency). Active only when passive is exhausted, then smallest probes: --top-ports 100 before anything wider, -T2/--max-rate caps, targeted -p on ports that matter, split scans across time, avoid nikto/metasploit until explicitly needed. Prefer kerbrute-style quiet techniques over password sprays.',
    }
  }
  if (profile === 'fast') {
    return {
      profile,
      maxFootprint: { recon: 2, enumeration: 5, vuln_analysis: 5, exploitation: 5, post_exploit: 3, reporting: 1 },
      guidance: 'FAST: optimize for speed — masscan full-range first, nmap -sV only on found ports, ffuf over dirsearch, parallel-friendly task groups. Footprint is secondary but rate limits still apply.',
    }
  }
  return {
    profile: 'balanced',
    maxFootprint: { recon: 2, enumeration: 4, vuln_analysis: 4, exploitation: 4, post_exploit: 3, reporting: 1 },
    guidance: 'BALANCED: passive recon first, --top-ports and capped rates during enumeration, widen only when results demand it, loud tools only in the exploitation phase with approval.',
  }
}
