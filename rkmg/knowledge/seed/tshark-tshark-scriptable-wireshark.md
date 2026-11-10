---
id: tshark-tshark-scriptable-wireshark
source: seed
kind: command_syntax
tool: tshark
title: "tshark = scriptable Wireshark"
tags: ["tshark", "wireshark", "sniff", "pcap", "arsenal"]
---
tshark is the Wireshark engine CLI: live capture tshark -i eth0 -c 50 -Y "tcp.port==80"; pcap conversations tshark -r f.pcap -q -z conv,tcp; follow stream -z follow,tcp,ascii,0; export HTTP objects --export-objects http,dir; JSON output -T json. Interfaces: tshark -D. Install: sudo apt install tshark.
