---
id: nmap-nmap-sweep-deep-combo
source: seed
kind: command_syntax
tool: nmap
title: "nmap sweep + deep combo"
tags: ["nmap", "port_scan", "pipeline"]
---
Do NOT sweep all 65535 ports with nmap — it is slow. Sweep with masscan/rustscan, then run nmap -sV -p <open ports> on just the found ports.
