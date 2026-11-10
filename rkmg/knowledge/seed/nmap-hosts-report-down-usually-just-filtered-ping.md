---
id: nmap-hosts-report-down-usually-just-filtered-ping
source: seed
kind: mistake
tool: nmap
title: "hosts report down — usually just filtered ping"
tags: ["nmap", "host_discovery"]
---
If nmap says host down, it usually means ICMP is filtered, not that the host is dead. Retry with -Pn (skip host discovery) before concluding anything.
