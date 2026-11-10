---
id: nmap-nmap-service-scan
source: seed
kind: tool_usage
tool: nmap
title: "nmap service scan"
tags: ["nmap", "port_scan", "service_enum"]
---
nmap -sV -Pn --top-ports 1000 <host> — version detection on the top ports. Always add -Pn: hosts that drop ping probes otherwise show as "down" and get skipped.
