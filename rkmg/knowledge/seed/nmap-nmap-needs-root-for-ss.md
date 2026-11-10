---
id: nmap-nmap-needs-root-for-ss
source: seed
kind: mistake
tool: nmap
title: "nmap needs root for -sS"
tags: ["nmap", "permissions"]
---
SYN scan (-sS) needs root. WSL runs as root here so it works; on permission errors fall back to -sT (full connect scan).
