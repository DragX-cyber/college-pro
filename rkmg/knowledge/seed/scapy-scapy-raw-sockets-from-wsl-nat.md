---
id: scapy-scapy-raw-sockets-from-wsl-nat
source: seed
kind: mistake
tool: scapy
title: "scapy raw sockets from WSL NAT"
tags: ["scapy", "wsl", "nat", "packet"]
---
Raw-socket scans (SYN/ARP) from inside WSL traverse the NAT — results can be empty or wrong against remote hosts. Cross-check anything surprising with nmap; ARP scans only work on the attached segment.
