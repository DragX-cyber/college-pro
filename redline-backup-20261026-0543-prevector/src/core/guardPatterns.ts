// ─────────────────────────────────────────────────────────────────────────────
// Guard patterns — deterministic pattern tables used by the guard pipeline.
//   • destructivePatterns: protect the OPERATOR'S OWN MACHINE. No off switch,
//     active in every mode including UNRESTRICTED.
//   • readOnly classification: recognizably read-only commands run
//     immediately; everything else raises an approval card.
//   • hostsIn(): extracts every host/IP/URL mentioned in a composed command
//     (files and binaries like cmd.exe are excluded from the check).
// ─────────────────────────────────────────────────────────────────────────────
import ipaddr from 'ipaddr.js'
import type { Classification } from './types'

export interface DestructiveMatch {
  pattern: string
  reason: string
}

// Patterns are evaluated against the full command line, case-insensitive.
export const DESTRUCTIVE_PATTERNS: { id: string; re: RegExp; reason: string }[] = [
  { id: 'rm -rf on root/home', re: /\brm\s+[^|;&>]*-[a-za-z]*[rf][a-za-z]*[rf][^|;&>]*\s+(\/(\s|$|\*)|\/(etc|usr|var|boot|bin|sbin|lib|root|home|opt|srv|dev)|~\/?\*?\s*$|\$HOME)/i, reason: 'recursive force-delete on a system path — this protects your own machine' },
  { id: 'fork bomb', re: /: *\(\) *\{[^}]*\|[^}]*&[^}]*\} *; *:/, reason: 'fork bomb detected' },
  { id: 'fork bomb (bash fn)', re: /\bfunction\s+\w+\s*\(\)\s*\{[^}]*\|\s*&/, reason: 'fork bomb pattern detected' },
  { id: 'mkfs', re: /\bmkfs(\.\w+)?\b/i, reason: 'filesystem format command' },
  { id: 'dd to raw device', re: /\bdd\b[^|;&]*\bof=\/dev\//i, reason: 'raw write to a device node' },
  { id: 'redirect to raw device', re: />\s*\/dev\/(sd|hd|nvme|vd|mmcblk)/i, reason: 'redirect to a raw disk device' },
  { id: 'shutdown/reboot', re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'system power control' },
  { id: 'init 0/6', re: /\binit\s+[06]\b/, reason: 'system power control via init' },
  { id: 'chmod 777 system', re: /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/, reason: 'world-writable system root' },
  { id: 'chown -R system', re: /\bchown\s+[^|;&]*-R[^|;&]*\s+\/(etc|usr|var|boot|bin|root)(\/|\s|$)/i, reason: 'recursive chown on a system path' },
  { id: 'wipefs/blkdiscard', re: /\b(wipefs|blkdiscard)\b/i, reason: 'block device wipe' },
  { id: 'kill all processes', re: /\bkill\s+(-9\s+)?-1\b/, reason: 'kill all processes' },
  { id: 'win format', re: /\bformat(\.com|\.exe)?\b[^&|;]*[c-z]:/i, reason: 'Windows format command' },
  { id: 'win del /f', re: /\bdel\s+\/[a-z]*f[a-z]*\s+\/[a-z]*s/i, reason: 'Windows recursive force delete' },
  { id: 'win rd /s', re: /\brd\s+\/s\b/i, reason: 'Windows recursive directory delete' },
  { id: 'diskpart clean', re: /\bdiskpart\b[^&|;]*\bclean\b/i, reason: 'Windows diskpart clean' },
  { id: 'vssadmin delete', re: /\bvssadmin\b[^&|;]*\bdelete\b/i, reason: 'Windows shadow copy deletion' },
  { id: 'bcdedit', re: /\bbcdedit\b/i, reason: 'Windows boot configuration edit' },
  { id: 'reg delete HKLM', re: /\breg\s+delete\b[^&|;]*HKLM/i, reason: 'Windows registry deletion' },
  { id: 'win rm -Recurse C:', re: /\bremove-item\b[^&|;]*-recurse[^&|;]*-force[^&|;]*c:\\\\/i, reason: 'PowerShell recursive force delete on C:\\' },
  { id: 'mv system to null', re: /\bmv\s+\/\w*\s+\/dev\/null/, reason: 'moving a system path to /dev/null' },
  { id: 'dd if=/dev/zero of=disk', re: /\bdd\b[^|;&]*if=\/dev\/(zero|random)[^|;&]*of=\/(dev|sd|hd|nvme)/i, reason: 'disk overwrite with dd' },
]

export function matchDestructive(command: string): DestructiveMatch | null {
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.re.test(command)) return { pattern: p.id, reason: p.reason }
  }
  return null
}

// ─── read-only classification ────────────────────────────────────────────────

const READONLY_BINS = new Set([
  // network reachability & DNS
  'ping', 'ping6', 'nslookup', 'dig', 'host', 'whois', 'traceroute', 'tracepath', 'tcptraceroute', 'mtr',
  // web probing / recon scanners
  'curl', 'wget', 'whatweb', 'wafw00f', 'httpx', 'httprobe', 'nikto', 'gobuster', 'ffuf', 'dirb', 'dirsearch', 'feroxybuster',
  // port & service scanning
  'nmap', 'masscan', 'rustscan', 'unicornscan',
  // dns/subdomain enumeration
  'dnsrecon', 'dnsenum', 'sublist3r', 'amass', 'theharvester', 'subfinder', 'assetfinder',
  // service enumeration (read)
  'snmpwalk', 'onesixtyone', 'nbtscan', 'enum4linux', 'smbclient', 'showmount', 'rpcinfo', 'ldapsearch',
  // ssl
  'sslscan', 'sslyze', 'testssl.sh', 'testssl', 'ssl-cert-check',
  // local recon / shell utilities (scratch dir context)
  'searchsploit', 'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'awk', 'sed', 'wc', 'file', 'stat',
  'find', 'which', 'whereis', 'type', 'echo', 'printf', 'env', 'printenv', 'id', 'whoami', 'uname', 'hostname',
  'pwd', 'date', 'sort', 'uniq', 'cut', 'tr', 'jq', 'column', 'xargs', 'true', 'false', 'sleep', 'clear',
  'less', 'more', 'md5sum', 'sha256sum', 'base64', 'xxd', 'strings', 'diff', 'tee', 'touch', 'mkdir', 'cp', 'mv', 'rm', 'ln',
  'tcpdump', 'nuclei',
])

const APPROVAL_BINS = new Set([
  'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'ftp',
  'hydra', 'medusa', 'john', 'hashcat', 'cewl', 'sqlmap', 'gobuster!',
  'msfconsole', 'msfvenom', 'metasploit', 'crackmapexec', 'netexec', 'cme', 'nuclei!',
  'responder', 'bettercap', 'ettercap', 'ettertext', 'arpspoof', 'sslstrip', 'dsniff',
  'redis-cli', 'mysql', 'psql', 'mssqlclient', 'sqsh', 'mongo', 'mongosh',
  'python3', 'python', 'node', 'perl', 'ruby', 'php', 'lua', 'bash', 'sh', 'zsh', 'dash', 'powershell', 'pwsh',
  'apt', 'apt-get', 'pip', 'pip3', 'npm', 'gem', 'cargo', 'go', 'git', 'wget!', 'impacket-smbexec', 'impacket-atexec', 'impacket-wmiexec',
  'impacket-psexec', 'impacket-secretsdump', 'impacket-getST', 'impacket-GetUserSPNs', 'impacket-getTGT', 'impacket-getuserspns',
  'kerbrute', 'enum4linux-ng', 'crackmapexec!', 'smbmap', 'rpcclient', 'wmiexec', 'smbexec', 'atexec', 'secretsdump',
  'searchsploit!', 'docker', 'kubectl',
])

// Write-ish flags that escalate a normally read-only binary to approval.
const CURL_WRITE = /(--request|-X)\s+(POST|PUT|DELETE|PATCH|CONNECT)|(--data|--data-raw|--data-binary|--data-urlencode|-d)\b|(--form|--form-string|-F)\b|(--upload-file|-T)\b/i
const WGET_WRITE = /--post|--put|(--body-file)/i
const SMB_WRITE = /\b(put|del|rm|rmdir|mkdir|rename|print\s)\b/i

export function classifySegment(segment: string): Classification {
  const cmd = segment.trim()
  if (!cmd) return { kind: 'readonly', reason: 'empty' }

  // strip leading env-var assignments and sudo (sudo ping is still ping; the
  // destructive-pattern table already blocks catastrophic sudo use)
  const cleaned = cmd.replace(/^(\w+=\S*\s+)+/, '').replace(/^sudo\s+/, '')
  const first = (cleaned.split(/\s+/)[0] || '').replace(/^["']|["']$/g, '')

  if (matchDestructive(cmd)) {
    return { kind: 'blocked', tool: first, reason: 'destructive pattern — this block has no off switch' }
  }

  if (first === 'curl' || first === 'wget') {
    const write = first === 'curl' ? CURL_WRITE.test(cmd) : WGET_WRITE.test(cmd)
    if (write) return { kind: 'approval', tool: first, reason: `${first} with write/upload flags` }
    return { kind: 'readonly', tool: first, reason: `${first} GET/HEAD — read-only fetch` }
  }
  if (first === 'smbclient') {
    if (SMB_WRITE.test(cmd.split(/\s+/).slice(1).join(' '))) {
      return { kind: 'approval', tool: first, reason: 'smbclient write operation (put/del/mkdir)' }
    }
    return { kind: 'readonly', tool: first, reason: 'smbclient listing/read' }
  }
  if (READONLY_BINS.has(first)) {
    return { kind: 'readonly', tool: first, reason: `${first} is a recognized read-only recon/utility command` }
  }
  if (APPROVAL_BINS.has(first)) {
    return { kind: 'approval', tool: first, reason: `${first} can mutate state or interact deeply — approval required` }
  }
  if (first === 'nmap' || first === 'masscan' || first === 'rustscan') {
    return { kind: 'readonly', tool: first, reason: 'port/service scanning is reconnaissance (charter still enforced)' }
  }
  return { kind: 'approval', tool: first, reason: `"${first}" is not a recognized read-only command — operator approval required` }
}

/** Split a command line on shell separators, respecting quotes. Each segment
 *  is classified; the strictest verdict wins. */
export function classifyCommand(command: string): Classification {
  const segments = splitShell(command)
  let verdict: Classification = { kind: 'readonly', reason: 'no-op' }
  const order = { readonly: 0, approval: 1, blocked: 2 } as const
  for (const seg of segments) {
    if (!seg.trim() || /^(&&|\|\||;|\|)$/.test(seg.trim())) continue
    const c = classifySegment(seg)
    if (order[c.kind] > order[verdict.kind]) verdict = c
    if (verdict.kind === 'blocked') return verdict
  }
  return verdict
}

export function splitShell(command: string): string[] {
  // split on ; && || | respecting single/double quotes — pragmatic regex
  const out: string[] = []
  let buf = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      buf += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; buf += ch; continue }
    if (ch === ';' || ch === '|' || ch === '&') {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      // consume a doubled separator
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

// ─── host extraction (free-terminal egress check) ────────────────────────────

const FILE_EXT = new Set([
  'txt', 'log', 'json', 'yaml', 'yml', 'py', 'js', 'ts', 'tsx', 'jsx', 'exe', 'dll', 'so', 'sh', 'conf',
  'csv', 'xml', 'html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'md', 'tar', 'gz', 'zip', '7z', 'db', 'bak',
  'ini', 'env', 'pem', 'key', 'crt', 'bin', 'img', 'iso', 'sql', 'rb', 'go', 'rs', 'java', 'jar', 'war',
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'css', 'lock', 'map', 'out', 'o', 'a', 'lib', 'dylib', 'deb', 'rpm',
  'ps1', 'bat', 'cmd', 'psm1', 'toml', 'plist', 'icns', 'woff', 'woff2', 'ttf', 'otf', 'mp4', 'mp3', 'wav',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'accdb', 'mdb', 'ldf', 'mdf', 'ndf', 'backup', 'old', 'orig', 'swp',
])

const WIN_BINS = new Set([
  'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wsl.exe', 'where.exe', 'findstr.exe', 'tasklist.exe',
  'netstat.exe', 'ipconfig.exe', 'nslookup.exe', 'ping.exe', 'curl.exe', 'tar.exe', 'sort.exe',
])

const IPV4_RE = /\b((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g
const IPV6_RE = /\b(?:[A-Fa-f0-9]{1,4}:){4,7}[A-Fa-f0-9]{1,4}\b|\b(?:[A-Fa-f0-9]{0,4}:){1,2}:(?::[A-Fa-f0-9]{1,4}){1,7}\b|\b::(?:[A-Fa-f0-9]{1,4}:)*[A-Fa-f0-9]{0,4}\b/g
const HOSTNAME_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\b/gi
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\[[^\]]+\]|[a-z][a-z0-9+.-]*:\/\/[^\s/:]+/gi

/** Flags whose following token is an EXCLUSION, not a target (nmap --exclude etc.) */
const EXCLUDE_FLAGS = new Set(['--exclude', '-exclude', '--exclude-file', '--excludefile', '--exclude-ports', '--exclude-ports'])

/**
 * Extract every host / IP / URL mentioned in a composed command.
 * Files and binaries (cmd.exe, /etc/resolv.conf, output.txt) are excluded so
 * they are not mistaken for hosts. Used by the free-terminal egress check:
 * one unchartered host refuses the whole command.
 */
export function hostsIn(command: string): string[] {
  const hosts = new Set<string>()

  // Track excluded tokens: the token AFTER --exclude-style flags is not a target
  const tokens = command.split(/\s+/)
  const excluded = new Set<string>()
  for (let i = 0; i < tokens.length - 1; i++) {
    if (EXCLUDE_FLAGS.has(tokens[i].replace(/=.*/, ''))) {
      excluded.add(tokens[i + 1].replace(/=.*$/, ''))
    }
  }
  const isExcluded = (t: string) => {
    if (excluded.has(t)) return true
    for (const e of excluded) {
      // excluded entry may itself be a CIDR (e.g. --exclude 10.0.0.0/8)
      if (e.includes('/')) {
        try {
          const [eAddr, ePrefix] = ipaddr.parseCIDR(e)
          const tClean = t.replace(/\/\d{1,3}$/, '')
          const tAddr = ipaddr.parse(tClean)
          if (tAddr.match([eAddr, ePrefix])) return true
        } catch { /* not an IP — fall through */ }
      }
    }
    return false
  }

  const addCandidate = (raw: string) => {
    let t = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    t = t.split('/')[0].split('?')[0].split('#')[0]
    t = t.replace(/^\[|\]$/g, '').replace(/:\d{1,5}$/, '')
    t = t.replace(/^@/, '').toLowerCase()
    if (!t || isExcluded(t)) return
    if (t === 'localhost' || t === '127.0.0.1' || t === '::1') { hosts.add(t); return }
    // skip anything with a path separator or drive letter (files)
    if (t.includes('\\')) return
    if (/^[a-z]:$/.test(t)) return
    // literal IPs (with or without a CIDR suffix) go straight in
    if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(t)) { hosts.add(t); return }
    if (/^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}(\/\d{1,3})?$/i.test(t)) { hosts.add(t); return }
    // dotted tokens: last label must be a plausible TLD, not a file extension
    const labels = t.split('.')
    if (labels.length >= 2) {
      const last = labels[labels.length - 1].toLowerCase()
      if (FILE_EXT.has(last)) return
      if (!/^[a-z]{2,24}$/.test(last)) return
      if (WIN_BINS.has(t)) return
    }
    hosts.add(t)
  }

  // URLs first (so scheme/host forms are captured cleanly)
  const urlMatches = command.match(URL_RE) ?? []
  for (const u of urlMatches) {
    const stripped = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    let host = stripped.split(/[/?#]/)[0]
    host = host.replace(/^\[|\]$/g, '').replace(/:\d{1,5}$/, '')
    if (host) addCandidate(host)
  }

  for (const m of command.match(IPV4_RE) ?? []) addCandidate(m)
  for (const m of command.match(IPV6_RE) ?? []) addCandidate(m.replace(/\/\d{1,3}$/, ''))
  // CIDR notation kept intact — the egress check verifies network containment
  for (const m of command.match(/\b\d{1,3}(\.\d{1,3}){3}\/\d{1,2}\b/g) ?? []) {
    const cidr = m
    if (!isExcluded(cidr)) hosts.add(cidr)
  }
  if (/\blocalhost\b/i.test(command)) hosts.add('localhost')
  for (const m of command.match(HOSTNAME_RE) ?? []) addCandidate(m)

  return Array.from(hosts)
}
