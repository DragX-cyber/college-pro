---
id: masscan-masscan-takes-ips-cidrs-not-hostnames
source: seed
kind: mistake
tool: masscan
title: "masscan takes IPs/CIDRs, NOT hostnames"
tags: ["masscan", "dns", "port_scan", "hostname"]
---
masscan does NOT resolve DNS: passing a hostname fails with "FAIL: unknown command-line parameter". Resolve first (dig +short <host> or nslookup) and pass the IP: masscan -p1-65535 <IP> --rate=500.
