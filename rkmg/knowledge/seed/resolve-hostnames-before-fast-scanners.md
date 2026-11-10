---
id: resolve-hostnames-before-fast-scanners
source: seed
kind: planning
tool: 
title: "resolve hostnames before fast scanners"
tags: ["planning", "dns", "pipeline", "port_scan"]
---
Pipeline for hostname targets: dig +short <host> (or nslookup) to get IPs FIRST, then masscan/rustscan the IP, then nmap -sV on open ports. masscan cannot resolve names; nmap and curl can.
