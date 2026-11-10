---
id: scapy-scapy-packet-crafting-one-liners
source: seed
kind: tool_usage
tool: scapy
title: "scapy packet crafting one-liners"
tags: ["scapy", "packet", "syn_scan", "arp", "arsenal"]
---
scapy runs as python3 one-liners (needs root): SYN scan sr1(IP(dst=t)/TCP(dport=p,flags="S")) — flags 0x12 = open, send RST after; ICMP sweep sr(IP(dst=cidr)/ICMP()); ARP scan srp(Ether(dst="ff:ff:ff:ff:ff:ff")/ARP(pdst=cidr)). The generate_payload action renders these ready-made.
