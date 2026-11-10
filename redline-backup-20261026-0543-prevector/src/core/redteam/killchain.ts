// ─────────────────────────────────────────────────────────────────────────────
// Kill chain & domain coverage — the platform's attack-surface matrix.
// Coverage target: ≥70% of industry attack domains — network, web, DNS,
// subdomains/OSINT, TLS, directories/params, SMB, Active Directory, SNMP,
// vulnerability scanning, exploitation ladder, post-exploit evidence.
// ─────────────────────────────────────────────────────────────────────────────
import type { Phase } from '../types'

export const PHASES: { id: Phase; label: string; description: string }[] = [
  { id: 'recon', label: '1 · Recon', description: 'Passive first (whois/DNS/OSINT), then minimal active reachability checks' },
  { id: 'enumeration', label: '2 · Enumeration', description: 'Ports, services, web surfaces, shares — the right tool per task' },
  { id: 'vuln_analysis', label: '3 · Vulnerability Analysis', description: 'Version-driven CVE matching, template scanning, TLS audit' },
  { id: 'exploitation', label: '4 · Exploitation', description: 'Safest-first exploit ladder, gated by the charter' },
  { id: 'post_exploit', label: '5 · Post-Exploit', description: 'Read-only evidence collection — never destructive' },
  { id: 'reporting', label: '6 · Reporting', description: 'Findings, honeypot flags, footprint accounting, remediation' },
]

export interface DomainDef {
  id: string
  label: string
  description: string
}

export const DOMAINS: DomainDef[] = [
  { id: 'network', label: 'Network & Services', description: 'Port/surface discovery and service versioning (masscan → nmap flow)' },
  { id: 'web', label: 'Web Applications', description: 'Technology fingerprinting, HTTP probing, WAF detection' },
  { id: 'dirs', label: 'Directories & Params', description: 'Hidden paths, files, parameters' },
  { id: 'dns', label: 'DNS & Subdomains', description: 'Records, zone behavior, subdomain enumeration, OSINT' },
  { id: 'tls', label: 'TLS / SSL', description: 'Cipher/protocol hygiene and known TLS vulns' },
  { id: 'smb', label: 'SMB / File Services', description: 'Shares, permissions, null sessions' },
  { id: 'ad', label: 'Active Directory', description: 'Kerberos behavior, user enumeration, credential validation' },
  { id: 'snmp', label: 'SNMP', description: 'Community strings and configuration leaks' },
  { id: 'vuln', label: 'Vulnerability Surface', description: 'Template scanning, Exploit-DB matching on found versions' },
  { id: 'exploit', label: 'Exploitation', description: 'Ladder-gated proof of impact' },
]

// ─── the safest-first exploit ladder ────────────────────────────────────────
// Rung 1 is always safe; rungs 4-5 stay disabled without a replica host.
export interface LadderRung {
  rung: number
  label: string
  description: string
  requiresReplica?: boolean
}

export const LADDER: LadderRung[] = [
  { rung: 1, label: 'Safe probe', description: 'Version-matching, PoC queries, benign payloads — no state change' },
  { rung: 2, label: 'Credential validation', description: 'Validate creds without exploiting (netexec --continue-on-success style)' },
  { rung: 3, label: 'Proof of concept', description: 'Demonstrate the weakness with a controlled, reversible PoC' },
  { rung: 4, label: 'Controlled exploit', description: 'Exploit against the replica host only', requiresReplica: true },
  { rung: 5, label: 'Full chain', description: 'End-to-end chain on the replica, evidence collected read-only', requiresReplica: true },
]

// ─── heuristic task templates (runner composes commands from these) ────────
export interface TaskTemplate {
  id: string
  title: string
  phase: Phase
  domain: string
  /** selector task id — the smart tool board decides the binary */
  toolTask: string
  /** command template; first available tool from strategy fills it. {target} placeholder. */
  commands: { bin: string; template: string; stealthTemplate?: string }[]
  /** footprint weight when no command matches */
  fallbackFootprint?: number
  rung?: number
  onlyIf?: { portsOpen?: number[]; hasWeb?: boolean; isWindowsInfra?: boolean }
}

export const TASK_TEMPLATES: TaskTemplate[] = [
  // ── recon ──
  {
    id: 'recon.passive.dns', title: 'DNS records & zone behavior', phase: 'recon', domain: 'dns', toolTask: 'dns_enum',
    commands: [
      { bin: 'dig', template: 'dig {target} ANY +noall +answer && echo --- && dig {target} MX +short && dig {target} NS +short' },
    ],
  },
  {
    id: 'recon.passive.whois', title: 'WHOIS ownership & infrastructure', phase: 'recon', domain: 'dns', toolTask: 'osint_recon',
    commands: [{ bin: 'whois', template: 'whois {target} | head -40' }],
  },
  {
    id: 'recon.reach', title: 'Reachability & TTL baseline', phase: 'recon', domain: 'network', toolTask: 'reachability',
    commands: [{ bin: 'ping', template: 'ping -c 4 -w 8 {target}' }],
  },
  // ── enumeration ──
  {
    id: 'enum.ports.fast', title: 'Port sweep (wide, fast)', phase: 'enumeration', domain: 'network', toolTask: 'port_scan',
    commands: [
      { bin: 'masscan', template: 'masscan -p1-65535 {target} --rate=1000', stealthTemplate: 'masscan -p 22,80,443,3389,445,3306,6379,8080 {target} --rate=200' },
      { bin: 'rustscan', template: 'rustscan -a {target} -p 1-65535 --no-banner' },
      { bin: 'nmap', template: 'nmap -Pn --top-ports 1000 {target}', stealthTemplate: 'nmap -Pn -T2 --top-ports 100 {target}' },
    ],
  },
  {
    id: 'enum.ports.followup', title: 'Service/version detail on open ports', phase: 'enumeration', domain: 'network', toolTask: 'service_enum',
    commands: [{ bin: 'nmap', template: 'nmap -sV -Pn --open {target}', stealthTemplate: 'nmap -sV -Pn -T2 --open --top-ports 200 {target}' }],
  },
  {
    id: 'enum.web.tech', title: 'Web technology fingerprint', phase: 'enumeration', domain: 'web', toolTask: 'tech_detect',
    commands: [
      { bin: 'whatweb', template: 'whatweb --color=never --no-errors http://{target}/ && whatweb --color=never --no-errors https://{target}/ || true' },
    ],
  },
  {
    id: 'enum.web.waf', title: 'WAF detection', phase: 'enumeration', domain: 'web', toolTask: 'waf_detect',
    commands: [{ bin: 'wafw00f', template: 'wafw00f http://{target}/ || true' }],
  },
  {
    id: 'enum.dirs', title: 'Hidden directories & files', phase: 'enumeration', domain: 'dirs', toolTask: 'dir_bruteforce',
    commands: [
      { bin: 'ffuf', template: 'ffuf -u http://{target}/FUZZ -w /usr/share/wordlists/dirb/common.txt -mc 200,204,301,302,307,401,403 -t 10 -of md -o /dev/null || ffuf -u http://{target}/FUZZ -w /usr/share/seclists/Discovery/Web-Content/common.txt -mc 200,204,301,302,307,401,403 -t 10' },
      { bin: 'gobuster', template: 'gobuster dir -u http://{target}/ -w /usr/share/wordlists/dirb/common.txt -t 10 || gobuster dir -u http://{target}/ -w /usr/share/dirb/wordlists/common.txt -t 10' },
      { bin: 'dirsearch', template: 'dirsearch -u http://{target}/ --quiet' },
    ],
  },
  {
    id: 'enum.dns.subs', title: 'Subdomain enumeration (passive first)', phase: 'enumeration', domain: 'dns', toolTask: 'subdomain_enum',
    commands: [
      { bin: 'sublist3r', template: 'sublist3r -d {target} -o subs-{target}.txt | head -60' },
      { bin: 'amass', template: 'amass enum -passive -d {target} 2>/dev/null | head -80' },
    ],
  },
  {
    id: 'enum.tls', title: 'TLS quick audit', phase: 'enumeration', domain: 'tls', toolTask: 'ssl_analyze',
    commands: [
      { bin: 'sslscan', template: 'sslscan --no-failed {target}:443 | head -60 || true' },
      { bin: 'testssl.sh', template: 'testssl.sh --quiet --color 0 {target} | head -80 || true' },
    ],
  },
  {
    id: 'enum.smb', title: 'SMB shares & null sessions', phase: 'enumeration', domain: 'smb', toolTask: 'smb_enum',
    commands: [
      { bin: 'enum4linux', template: 'enum4linux -a {target} | head -100 || true' },
      { bin: 'smbmap', template: 'smbmap -H {target} || true' },
      { bin: 'nbtscan', template: 'nbtscan {target} || true' },
    ],
  },
  {
    id: 'enum.snmp', title: 'SNMP community strings', phase: 'enumeration', domain: 'snmp', toolTask: 'snmp_enum',
    commands: [
      { bin: 'onesixtyone', template: 'onesixtyone -c /usr/share/wordlists/wordlist {target} 2>/dev/null || onesixtyone {target} || true' },
      { bin: 'snmpwalk', template: 'snmpwalk -v2c -c public {target} 2>&1 | head -60 || true' },
    ],
  },
  // ── vuln analysis ──
  {
    id: 'vuln.nuclei', title: 'Template vulnerability scan', phase: 'vuln_analysis', domain: 'vuln', toolTask: 'vuln_scan',
    commands: [{ bin: 'nuclei', template: 'nuclei -u http://{target}/ -severity medium,high,critical -rl 15 2>/dev/null | head -80 || true' }],
  },
  {
    id: 'vuln.tls.deep', title: 'Deep TLS vulnerability audit', phase: 'vuln_analysis', domain: 'tls', toolTask: 'ssl_analyze',
    commands: [{ bin: 'testssl.sh', template: 'testssl.sh --quiet --color 0 {target} 2>/dev/null | head -120 || true' }],
  },
  {
    id: 'vuln.exploitdb', title: 'Exploit-DB match on discovered versions', phase: 'vuln_analysis', domain: 'vuln', toolTask: 'exploit_search',
    commands: [{ bin: 'searchsploit', template: 'searchsploit --nmap /dev/null 2>/dev/null; searchsploit {target} | head -30 || true' }],
  },
  // ── exploitation (ladder-gated) ──
  {
    id: 'exploit.rung1.safe', title: 'Ladder rung 1 — safe probe / version match', phase: 'exploitation', domain: 'exploit', toolTask: 'exploit_search', rung: 1,
    commands: [{ bin: 'searchsploit', template: 'searchsploit {target} 2>/dev/null | head -20; echo "[rung 1] safe probe complete — match versions, plan rung 2"' }],
  },
  {
    id: 'exploit.rung2.cred', title: 'Ladder rung 2 — credential validation (benign)', phase: 'exploitation', domain: 'ad', toolTask: 'cred_validation', rung: 2,
    commands: [{ bin: 'netexec', template: 'netexec smb {target} -u guest -p "" --continue-on-success 2>/dev/null | head -20 || echo "[rung 2] netexec unavailable — manual validation"' }],
  },
  {
    id: 'exploit.rung3.poc', title: 'Ladder rung 3 — proof of concept', phase: 'exploitation', domain: 'exploit', toolTask: 'exploit_run', rung: 3,
    commands: [{ bin: 'searchsploit', template: 'echo "[rung 3] PoC plan — operator guidance:"; searchsploit {target} | head -15' }],
  },
  // ── post exploit ──
  {
    id: 'post.evidence', title: 'Read-only evidence collection', phase: 'post_exploit', domain: 'network', toolTask: 'banner_grab',
    commands: [{ bin: 'curl', template: 'curl -sS -m 20 -I http://{target}/ 2>/dev/null | head -20 || true' }],
  },
]

export function templateById(id: string): TaskTemplate | undefined {
  return TASK_TEMPLATES.find((t) => t.id === id)
}
