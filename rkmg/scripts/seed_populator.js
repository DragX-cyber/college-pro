import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const seedEntries = [
  { kind: 'tool_usage', tool: 'nmap', title: 'nmap service scan', content: 'nmap -sV -Pn --top-ports 1000 <host> — version detection on the top ports. Always add -Pn: hosts that drop ping probes otherwise show as "down" and get skipped.', tags: ['nmap', 'port_scan', 'service_enum'] },
  { kind: 'mistake', tool: 'nmap', title: 'hosts report down — usually just filtered ping', content: 'If nmap says host down, it usually means ICMP is filtered, not that the host is dead. Retry with -Pn (skip host discovery) before concluding anything.', tags: ['nmap', 'host_discovery'] },
  { kind: 'command_syntax', tool: 'nmap', title: 'nmap sweep + deep combo', content: 'Do NOT sweep all 65535 ports with nmap — it is slow. Sweep with masscan/rustscan, then run nmap -sV -p <open ports> on just the found ports.', tags: ['nmap', 'port_scan', 'pipeline'] },
  { kind: 'mistake', tool: 'nmap', title: 'nmap needs root for -sS', content: 'SYN scan (-sS) needs root. WSL runs as root here so it works; on permission errors fall back to -sT (full connect scan).', tags: ['nmap', 'permissions'] },
  { kind: 'tool_usage', tool: 'nmap', title: 'nmap NSE scripts', content: 'nmap --script safe <host> for quiet checks; --script vuln runs the vuln NSE set but is LOUD. Parse "PORT/PROTO STATE SERVICE" lines from output.', tags: ['nmap', 'vuln_scan', 'scripts'] },
  { kind: 'command_syntax', tool: 'masscan', title: 'masscan always needs --rate', content: 'masscan -p1-65535 <host> --rate=1000 — always pass an explicit --rate (packets/sec). Without it the default can saturate the link; for stealth use --rate=200-500. Sweeping large ranges fast is exactly what masscan is for.', tags: ['masscan', 'port_scan', 'speed', 'sweep'] },
  { kind: 'mistake', tool: 'masscan', title: 'masscan gives no service info', content: 'masscan only finds OPEN ports — no banners or versions. Follow up with nmap -sV on the found ports; do not try to fingerprint with masscan.', tags: ['masscan', 'service_enum'] },
  { kind: 'mistake', tool: 'masscan', title: 'masscan takes IPs/CIDRs, NOT hostnames', content: 'masscan does NOT resolve DNS: passing a hostname fails with "FAIL: unknown command-line parameter". Resolve first (dig +short <host> or nslookup) and pass the IP: masscan -p1-65535 <IP> --rate=500.', tags: ['masscan', 'dns', 'port_scan', 'hostname'] },
  { kind: 'mistake', tool: 'masscan', title: 'masscan no results in WSL', content: 'If masscan returns nothing from WSL, the raw socket/interface may have failed. Verify with rustscan or nmap on a few known ports; try --rate 500 and a specific -p list.', tags: ['masscan', 'wsl'] },
  { kind: 'command_syntax', tool: 'masscan', title: 'sweep time math: rate × ports vs the 90s timeout', content: 'Full 65535-port sweep at --rate=500 needs ≥131s — the default command timeout is 90s, so it WILL be killed. Fix: raise the rate (--rate=2000 → ~35s), narrow the port list (-p 1-1000), or pass "timeoutMs":240000 on the shell action. Timed-out output still lists ports found so far — parse it, never re-run the identical sweep.', tags: ['masscan', 'timeout', 'port_scan', 'sweep'] },
  { kind: 'planning', title: 'timed-out commands: harvest the partial output', content: 'When a command is killed at the timeout, its captured output so far is still returned. Streaming scanners (masscan/nmap) report findings as they go — extract what was found and CONTINUE (e.g. nmap -sV on those ports). Re-running the identical long command wastes the whole timeout again.', tags: ['planning', 'timeout', 'timeouts', 'output'] },
  { kind: 'planning', title: 'resolve hostnames before fast scanners', content: 'Pipeline for hostname targets: dig +short <host> (or nslookup) to get IPs FIRST, then masscan/rustscan the IP, then nmap -sV on open ports. masscan cannot resolve names; nmap and curl can.', tags: ['planning', 'dns', 'pipeline', 'port_scan'] },
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
  { kind: 'tool_usage', tool: 'rustscan', title: 'rustscan pipes into nmap', content: 'rustscan -a <host> --ulimit 5000 -p 1-65535 -- -sV — everything after -- is handed to nmap automatically. Fast sweep + deep enum in one command.', tags: ['rustscan', 'port_scan', 'pipeline'] },
  { kind: 'mistake', tool: 'ping', title: 'ping 100% loss != dead host', content: 'ICMP is commonly filtered by firewalls. 100% packet loss does NOT mean the host is down — verify with nmap -Pn, curl, or nslookup before concluding.', tags: ['ping', 'reachability'] },
  { kind: 'command_syntax', tool: 'ping', title: 'ping usage', content: 'ping -c 4 <host> — 4 packets is enough. TTL hints at OS: ~128 Windows, ~64 Linux. Use for reachability + TTL honeypot signals only.', tags: ['ping', 'reachability', 'ttl'] },
  { kind: 'command_syntax', tool: 'curl', title: 'curl essentials', content: 'curl -I for headers only, -s silent, -L follow redirects, -k ignore TLS errors (self-signed), --max-time 10 to avoid hangs. Always set --max-time in agent commands.', tags: ['curl', 'web'] },
  { kind: 'mistake', tool: 'curl', title: 'curl hangs without timeout', content: 'A curl without --max-time can hang until the command budget kills it and you lose the output. Always add --max-time (5-15s).', tags: ['curl', 'timeouts'] },
  { kind: 'command_syntax', tool: 'curl', title: '302/301 redirect bodies', content: 'A short "302 Moved Temporarily" body means the real page is behind a redirect — do not re-try headers, just add -L (follow redirects): curl -sL --max-time 10 <url>. One -L request replaces three guessing attempts.', tags: ['curl', 'redirect', 'http', '302'] },
  { kind: 'mistake', tool: 'curl', title: 'curl on odd ports needs explicit scheme', content: 'Use http://host:port or https://host:port explicitly. On https with self-signed certs add -k or you get certificate errors instead of content.', tags: ['curl', 'tls'] },
  { kind: 'command_syntax', tool: 'dig', title: 'dig quick lookups', content: 'dig +short <domain> A for fast answers; dig <domain> MX/TXT/NS for records. dig ANY is often refused by resolvers — query specific types.', tags: ['dig', 'dns'] },
  { kind: 'mistake', tool: 'dig', title: 'dig no servers could be reached in WSL', content: 'WSL NAT resolvers sometimes fail. Retry with an explicit resolver: dig @1.1.1.1 <domain> +short. nslookup uses the same resolver — same fix.', tags: ['dig', 'dns', 'wsl'] },
  { kind: 'tool_usage', tool: 'nslookup', title: 'nslookup basics', content: 'nslookup <domain> for A records; nslookup -type=MX <domain> for mail servers. The "Server: 10.255.255.254" line is the WSL NAT resolver — normal, not a finding.', tags: ['nslookup', 'dns', 'wsl'] },
  { kind: 'tool_usage', tool: 'whois', title: 'whois is passive recon', content: 'whois <domain> returns registrar, nameservers, abuse contact, dates — zero packets to the target. Always safe first step for a domain.', tags: ['whois', 'recon', 'passive'] },
  { kind: 'tool_usage', tool: 'openssl', title: 'TLS cert inspection', content: 'openssl s_client -connect host:443 -brief </dev/null — shows cert chain, issuer, expiry. Useful for recon and finding internal names in SANs.', tags: ['openssl', 'tls', 'recon'] },
  { kind: 'tool_usage', tool: 'whatweb', title: 'whatweb fingerprinting', content: 'whatweb <url> — quiet CMS/framework/tech fingerprint. Good FIRST web step before loud scanners like nikto.', tags: ['whatweb', 'web', 'recon'] },
  { kind: 'tool_usage', tool: 'ffuf', title: 'ffuf directory/content brute', content: 'ffuf -u <url>/FUZZ -w <wordlist> -mc 200,301,302 -t 20 — filter noise with -mc/-fc. Common mistake: no -fc 404 drowning output in misses.', tags: ['ffuf', 'web', 'directories'] },
  { kind: 'mistake', tool: 'nikto', title: 'nikto is very loud', content: 'nikto -h <host> sends thousands of probes — fine in a lab, avoid in stealth engagements (use whatweb + manual checks instead).', tags: ['nikto', 'web', 'stealth'] },
  { kind: 'command_syntax', tool: 'hydra', title: 'hydra usage', content: 'hydra -l <user> -P <wordlist> <service>://<host> — cap threads with -t 4-8. One protocol per run; check the service is actually exposed first.', tags: ['hydra', 'creds', 'brute'] },
  { kind: 'mistake', tool: 'hydra', title: 'hydra web forms need form syntax', content: 'HTTP form brute needs: hydra -L users -P pass host http-post-form "/login:user=^USER^&pass=^PASS^:F=failed-text". Without the failure string it reports everything as success.', tags: ['hydra', 'web', 'creds'] },
  { kind: 'command_syntax', tool: 'sqlmap', title: 'sqlmap gentle start', content: 'sqlmap -u "<url with param>" --batch --level=1 --risk=1 — start low; escalate level/risk only if nothing found and you are authorized. Never against params outside charter.', tags: ['sqlmap', 'web', 'sqli'] },
  { kind: 'tool_usage', tool: 'enum4linux', title: 'enum4linux SMB enum', content: 'enum4linux -a <host> — users, shares, groups, policy via SMB/NetBIOS. Requires smbclient; run only after 445/139 is confirmed open.', tags: ['enum4linux', 'smb'] },
  { kind: 'command_syntax', tool: 'snmpwalk', title: 'SNMP two-step', content: 'First onesixtyone <host> for community brute (public/private), then snmpwalk -v2c -c <community> <host> to dump OIDs. SNMP without a valid community returns nothing.', tags: ['snmpwalk', 'onesixtyone', 'snmp'] },
  { kind: 'tool_usage', tool: 'searchsploit', title: 'searchsploit offline exploit DB', content: 'searchsploit <software> <version> — local Exploit-DB copy, zero network traffic. -m <id> mirrors the exploit file into the cwd. Always version-pin from service_enum results first.', tags: ['searchsploit', 'vuln_scan'] },
  { kind: 'planning', title: 'recon order: passive -> sweep -> enum -> web', content: 'Correct order: passive (whois/dig/cert) → port sweep (masscan/rustscan) → service enum (nmap -sV on open ports) → web fingerprint (whatweb) → targeted checks. Never start with loud tools.', tags: ['planning', 'recon', 'methodology'] },
  { kind: 'planning', title: 'pipeline: sweep feeds enum', content: 'masscan/rustscan find open ports fast; nmap -sV -p <ports> deep-enums them. Running nmap on all ports OR skipping deep enum after a sweep are both mistakes.', tags: ['planning', 'port_scan', 'service_enum', 'pipeline'] },
  { kind: 'planning', title: 'honeypot caution before creds', content: 'Signs of honeypots: rare ports wide open, default creds everywhere, instant responses, unusual banner uniformity. Run flag_honeypot before any credential attack.', tags: ['planning', 'honeypot', 'creds'] },
  { kind: 'planning', title: 'record findings as you go', content: 'Every meaningful result goes to note_finding with the exact command + key output lines in detail. The final report is built from these, not re-derived.', tags: ['planning', 'reporting', 'findings'] },
  { kind: 'planning', title: 'budget discipline: batch commands', content: 'Steps per turn are limited (~24). Batch related probes into one command (one nmap with a port list, not five nmaps). Parse output with grep/head to keep observations small.', tags: ['planning', 'budget', 'efficiency'] },
  { kind: 'planning', title: 'programs run via the shell action', content: 'Programs are executed with {"tool":"shell","command":"<program> <args>"}. The program name (nmap, curl...) is NEVER the tool name. One action per reply, JSON only.', tags: ['planning', 'protocol', 'shell'] },
  { kind: 'mistake', tool: 'nuclei', title: 'nuclei missing — use fallbacks', content: 'If the strategy board names nuclei but it is not installed, do NOT give up: use nmap --script vuln <host>, searchsploit <software> <version> after service enum, and manual checks (curl -I, version-vs-CVE reasoning). Say which fallback you chose in your thought.', tags: ['nuclei', 'vuln_scan', 'fallback'] }
];

const seedDir = path.resolve(__dirname, '../knowledge/seed');
if (!fs.existsSync(seedDir)) {
  fs.mkdirSync(seedDir, { recursive: true });
}

let count = 0;
for (const entry of seedEntries) {
  const slug = (entry.tool ? `${entry.tool}-${entry.title}` : entry.title)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);

  const filename = `${slug}.md`;
  const filePath = path.join(seedDir, filename);

  const fileContent = `---
id: ${slug}
source: seed
kind: ${entry.kind}
tool: ${entry.tool || ''}
title: "${entry.title}"
tags: [${entry.tags.map((t) => `"${t}"`).join(', ')}]
---
${entry.content}
`;

  fs.writeFileSync(filePath, fileContent, 'utf-8');
  count++;
}

console.log(`Successfully generated ${count} seed markdown entries in ${seedDir}`);

