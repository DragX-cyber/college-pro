---
id: masscan-masscan-always-needs-rate
source: seed
kind: command_syntax
tool: masscan
title: "masscan always needs --rate"
tags: ["masscan", "port_scan", "speed", "sweep"]
---
masscan -p1-65535 <host> --rate=1000 — always pass an explicit --rate (packets/sec). Without it the default can saturate the link; for stealth use --rate=200-500. Sweeping large ranges fast is exactly what masscan is for.
