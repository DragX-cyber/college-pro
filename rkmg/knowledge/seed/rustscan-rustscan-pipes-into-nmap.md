---
id: rustscan-rustscan-pipes-into-nmap
source: seed
kind: tool_usage
tool: rustscan
title: "rustscan pipes into nmap"
tags: ["rustscan", "port_scan", "pipeline"]
---
rustscan -a <host> --ulimit 5000 -p 1-65535 -- -sV — everything after -- is handed to nmap automatically. Fast sweep + deep enum in one command.
