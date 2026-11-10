// Core engine smoke test — run with: bun scripts/smoke-core.ts
import { loadCharter, resolveTarget, normalizeHost, ipInNetworks } from '../src/core/charter'
import { classifyCommand, hostsIn, matchDestructive } from '../src/core/guardPatterns'
import { selectStrategy } from '../src/core/tools/selector'
import { MARKETPLACE_CATALOG } from '../src/core/marketplace/catalog'
import { analyzeText } from '../src/core/redteam/honeypot'
import { estimateFootprint } from '../src/core/redteam/footprint'
import { planEngagement } from '../src/core/redteam/planner'
import { detectOS } from '../src/core/os'

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name} ${extra}`) }
}

console.log('── charter ──')
const c = loadCharter()
check('default charter has localhost', c.scope.hosts.includes('localhost'))
check('normalizeHost strips URL', normalizeHost('http://pentest-ground.com:8080/path?q=1') === 'pentest-ground.com')
check('ipInNetworks 127.0.0.1/32', ipInNetworks('127.0.0.1', ['127.0.0.1/32']))
check('ipInNetworks rejects 8.8.8.8', !ipInNetworks('8.8.8.8', ['127.0.0.1/32']))
const rOk = await resolveTarget(c, 'http://localhost:3000/')
check('resolveTarget localhost ok', rOk.ok)
const rBad = await resolveTarget(c, 'example.com')
check('resolveTarget example.com refused', !rBad.ok && !!rBad.fix)
const rIp = await resolveTarget(c, '8.8.8.8')
check('resolveTarget literal IP refused', !rIp.ok)

console.log('── destructive patterns (no off switch) ──')
check('rm -rf / blocked', !!matchDestructive('rm -rf /'))
check('fork bomb blocked', !!matchDestructive(':(){ :|:& };:'))
check('dd of=/dev/sda blocked', !!matchDestructive('dd if=/dev/zero of=/dev/sda'))
check('format c: blocked', !!matchDestructive('format C: /y'))
check('plain nmap not blocked', !matchDestructive('nmap -sV localhost'))

console.log('── classification ──')
check('nmap readonly', classifyCommand('nmap -sV localhost').kind === 'readonly')
check('curl GET readonly', classifyCommand('curl -sS http://localhost/').kind === 'readonly')
check('curl POST approval', classifyCommand('curl -X POST http://localhost/api -d x=1').kind === 'approval')
check('hydra approval', classifyCommand('hydra -L u.txt -P p.txt localhost ssh').kind === 'approval')
check('msfconsole approval', classifyCommand('msfconsole -q -x "exit"').kind === 'approval')
check('pipe nmap|grep readonly', classifyCommand('nmap -sV localhost | grep open').kind === 'readonly')
check('rm -rf / blocked', classifyCommand('rm -rf /').kind === 'blocked')
check('python3 approval', classifyCommand('python3 exploit.py').kind === 'approval')
check('apt-get approval', classifyCommand('sudo apt-get install nmap').kind === 'approval')

console.log('── hosts extraction ──')
const h1 = hostsIn('nmap -sV pentest-ground.com')
check('extracts hostname', h1.includes('pentest-ground.com'), JSON.stringify(h1))
const h2 = hostsIn('curl http://127.0.0.1:8080/api?x=1')
check('extracts IP', h2.includes('127.0.0.1'), JSON.stringify(h2))
const h3 = hostsIn('nmap --exclude 10.0.0.5 192.168.1.0/24')
check('excludes --exclude target', !h3.includes('10.0.0.5') && h3.some((h) => h.startsWith('192.168.1')), JSON.stringify(h3))
const h3b = hostsIn('nmap --exclude 10.0.0.0/8 10.0.5.5')
check('excludes --exclude CIDR', !h3b.includes('10.0.5.5'), JSON.stringify(h3b))
const h4 = hostsIn('cat /etc/resolv.conf && ls cmd.exe notes.txt')
check('files/binaries not hosts', h4.length === 0, JSON.stringify(h4))
const h5 = hostsIn('nslookup google.com')
check('domain extracted', h5.includes('google.com'), JSON.stringify(h5))

console.log('── smart selector (nmap vs masscan) ──')
const { installTool } = await import('../src/core/marketplace/manager')
await installTool('nmap')
await installTool('masscan')
const speedStrategy = selectStrategy('port_scan', { priority: 'speed' })
check('masscan wins speed port_scan', speedStrategy.primary?.id === 'masscan', JSON.stringify(speedStrategy.primary))
check('complement suggests nmap', speedStrategy.complement?.tools.includes('nmap') ?? false, JSON.stringify(speedStrategy.complement))
const svcStrategy = selectStrategy('service_enum', { priority: 'reliability' })
check('nmap wins service_enum', svcStrategy.primary?.id === 'nmap', JSON.stringify(svcStrategy.primary))

console.log('── honeypot heuristics ──')
const fakeScan = [21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 443, 445, 993, 995, 1433, 3306, 3389, 5432, 5900, 6379, 8080, 9200]
  .map((p) => `${p}/tcp  open  svc${p}`).join('\n') + '\n220 Welcome to Ubuntu honeypot'
const hp = analyzeText('fake.target', fakeScan)
check('honeypot detected', hp?.verdict === 'likely_honeypot', hp ? `${hp.score} ${hp.verdict}` : 'null')
const cleanScan = '22/tcp  open  ssh  OpenSSH 8.9\n80/tcp open  http nginx'
const hpClean = analyzeText('ok.target', cleanScan)
check('clean host not flagged', hpClean?.verdict === 'clean', JSON.stringify(hpClean?.score))

console.log('── footprint ──')
check('whois = passive(1)', estimateFootprint('whois example.com') === 1)
check('masscan full = 5', estimateFootprint('masscan -p1-65535 x --rate=5000') === 5)
check('curl = 2', estimateFootprint('curl -I http://x/') === 2)

console.log('── planner ──')
const plan = planEngagement({ target: 'localhost', objective: 'test', profile: 'balanced', domains: [] })
check('plan has 5+ phases', plan.phases.length >= 5, plan.phases.map((p) => p.phase).join(','))
check('plan has 13+ core tasks', plan.phases.reduce((s, p) => s + p.groups.reduce((x, g) => x + g.tasks.length, 0), 0) >= 13)

console.log('── OS detection ──')
const osInfo = detectOS()
console.log(`  platform=${osInfo.platform} exec=${osInfo.exec.kind} scratch=${osInfo.exec.scratchRoot}`)
check('exec kind resolved', ['wsl-bash', 'native-bash', 'powershell'].includes(osInfo.exec.kind))


console.log('── knowledge RAG ──')
import { seedKnowledge, searchKnowledge, getKnowledgeContext, createCommandHint, recordMistake, deleteKnowledge, createKnowledge } from '../src/core/knowledge'
const seed = await seedKnowledge(true)
check('seed inserts entries', seed.inserted >= 30 && !seed.skipped, `${seed.inserted}`)
const sweepHits = await searchKnowledge('fast port sweep of a large range', { limit: 3 })
check('search ranks masscan for speed query', sweepHits[0]?.entry.tool === 'masscan', sweepHits[0]?.entry.tool ?? 'none')
const nmapHits = await searchKnowledge('host shows as down', { limit: 3 })
check('search surfaces nmap mistake for "down"', nmapHits.some((h) => h.entry.tool === 'nmap' && h.entry.kind === 'mistake'), nmapHits[0]?.entry.tool ?? 'none')
const ctx = await getKnowledgeContext('plan a recon of the target and scan open ports')
check('context respects char cap', ctx.length > 0 && ctx.length <= 1300, `${ctx.length}`)
const hintOk = await createCommandHint('nmap', 0)
const hintFail = await createCommandHint('nmap', 1)
check('command hint exists for nmap', hintOk.length > 0)
check('failure hint prefers mistakes', hintFail.toLowerCase().includes('down') || hintFail.length > 0)
const m1 = await recordMistake({ tool: 'smoketest', command: 'smoketest --x 1', errorHead: 'Error: bad flag 42' })
const m1id = m1?.id ?? -1
check('recordMistake inserts', m1id > 0, `${m1id}`)
const m2 = await recordMistake({ tool: 'smoketest', command: 'smoketest --x 2', errorHead: 'Error: bad flag 77' })
check('recordMistake dedupes by signature', m1id > 0 && m2 === null, `m2=${m2 === null ? 'null' : 'dup'}`)
// engine-level search: the operator path sees every entry…
check('mistake is searchable (operator path)', (await searchKnowledge('smoketest bad flag', { limit: 5, ignoreSettings: true })).some((h) => h.entry.tool === 'smoketest'))
// …and the agent path hides knowledge about a tool the registry doesn't know (connected-tools constraint)
check('connected-tools filter hides non-registry mistake', !(await searchKnowledge('smoketest bad flag', { limit: 5 })).some((h) => h.entry.tool === 'smoketest'))
await deleteKnowledge(m1id)
const tmp = await createKnowledge({ kind: 'planning', title: 'smoke temp', content: 'tmp' })
await deleteKnowledge(tmp.id)
check('create/delete roundtrip', !(await searchKnowledge('smoke temp', { limit: 5 })).some((h) => h.entry.title === 'smoke temp'))


console.log('── shell_batch (parallel recon) ──')
import { planBatch, formatBatchObservation } from '../src/core/tools/batch'
const bOk = planBatch(['dig +short x', 'whois x', 'dig +short x'], { charterMax: 4 })
check('planBatch dedupes + accepts', bOk.ok && bOk.plan.commands.length === 2, JSON.stringify(bOk.ok ? bOk.plan.commands : bOk))
check('planBatch cap enforced', !planBatch(['a', 'b', 'c', 'c2'], { charterMax: 2 }).ok)
check('planBatch needs 2 distinct', !planBatch(['same', 'same '], { charterMax: 4 }).ok)
check('planBatch disabled at cap 1', !planBatch(['a', 'b'], { charterMax: 1 }).ok)
check('planBatch rejects non-array', !planBatch('nmap x', { charterMax: 4 }).ok)
const fmt = formatBatchObservation([
  { command: 'dig +short h', exitCode: 0, output: '1.2.3.4' },
  { command: 'masscan p', exitCode: 1, output: 'FAIL bad param', hint: 'resolve first' },
  { command: 'x', exitCode: null, output: '', refused: 'rate_limited: slow down' },
])
check('batch observation joins all', fmt.includes('[1/3]') && fmt.includes('REFUSED') && fmt.includes('[KNOWLEDGE] resolve first'))
check('batch observation capped', fmt.length <= 2700)


console.log('── vector embeddings ──')
import { cosine } from '../src/core/knowledge-embed'
check('cosine identical = 1', Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9)
check('cosine orthogonal = 0', Math.abs(cosine([1, 0], [0, 1])) < 1e-9)
check('cosine opposite = -1', Math.abs(cosine([1, 0], [-1, 0]) + 1) < 1e-9)
check('cosine empty = 0', cosine([], []) === 0)
// embedder normally off in CI — hybrid search must degrade to keyword-only
const kwOnly = await searchKnowledge('fast port sweep of a large range', { limit: 3 })
check('hybrid degrades to keyword when embedder down', kwOnly.length > 0 && kwOnly[0].entry.tool === 'masscan', kwOnly[0]?.entry.tool ?? 'none')


console.log('── red team arsenal ──')
import { arsenalCatalog, generateArsenal } from '../src/core/redteam/arsenal'
check('arsenal has 18+ generators', arsenalCatalog().length >= 18, String(arsenalCatalog().length))
const rs = generateArsenal('revshell_python', { lhost: '10.10.14.2', lport: '4444' })
check('revshell substitutes host/port', !('error' in rs) && rs.output.includes('10.10.14.2') && rs.output.includes('4444') && !!rs.handler)
const msf = generateArsenal('msf_meterpreter_windows', { lhost: '1.2.3.4', lport: '9001', outfile: 's.exe' })
check('msfvenom builder + handler pair', !('error' in msf) && msf.output.startsWith('msfvenom') && !!msf.handler?.includes('multi/handler'))
const bad = generateArsenal('does_not_exist', {})
check('unknown kind returns error', 'error' in bad)
const beacon = generateArsenal('sniff_beacon_hunt', { file: 'cap.pcap' })
check('beacon hunt renders awk pipeline', !('error' in beacon) && beacon.output.includes('frame.time_epoch') && beacon.output.includes('awk'))
const lab = generateArsenal('pkt_syn_flood_lab', { target: '10.0.0.5', port: '80' })
check('syn flood carries LAB-ONLY caveat', !('error' in lab) && !!lab.caveats?.toLowerCase().includes('lab'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

