---
id: ping-ping-100-loss-dead-host
source: seed
kind: mistake
tool: ping
title: "ping 100% loss != dead host"
tags: ["ping", "reachability"]
---
ICMP is commonly filtered by firewalls. 100% packet loss does NOT mean the host is down — verify with nmap -Pn, curl, or nslookup before concluding.
